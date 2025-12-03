require('dotenv').config();
const express = require("express");
const session = require("express-session");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

// =========================================
// 1. APP CONFIGURATION
// =========================================
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// Parse form data
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// =========================================
// 2. DATABASE CONNECTION (Knex)
// =========================================
const knex = require("knex")({
    client: "pg",
    connection: {
        host: process.env.RDS_HOSTNAME || "localhost",
        user: process.env.RDS_USERNAME || "postgres",
        password: process.env.RDS_PASSWORD || "YLj13cO1",
        database: process.env.RDS_DB_NAME || "ebdb",
        port: process.env.RDS_PORT || 5432,
        ssl: process.env.DB_SSL ? { rejectUnauthorized: false } : false // Force SSL if env var set
    }
});

// =========================================
// 3. SESSION SETUP
// =========================================
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if hosting on HTTPS
}));

// =========================================
// 4. GLOBAL USER MIDDLEWARE
// =========================================
app.use((req, res, next) => {
    // Make user data available to all EJS templates
    if (req.session && req.session.username) {
        res.locals.user = {
            username: req.session.username,
            firstName: req.session.firstName,
            role: req.session.level === 'M' ? 'Manager' : 'User'
        };
    } else {
        res.locals.user = null;
    }
    next();
});

// =========================================
// 5. PUBLIC ROUTES
// =========================================

// Landing Page
app.get("/", (req, res) => {
    res.render("index");
});

// --- SIGNUP ROUTES ---
app.get("/signup", (req, res) => {
    res.render("signup");
});

app.post('/signup', async (req, res) => {
    // Update 1: Destructure 'dob' instead of 'userdob'
    const { username, password, firstname, lastname, dob, email, phone, city, state, zip } = req.body;

    try {
        // Check for existing user...
        const existingUser = await knex('users')
            .where('email', email.toLowerCase())
            .orWhere('username', username.toLowerCase())
            .first();

        if (existingUser) {
            return res.render('signup', {
                error: 'An account with this email or username already exists',
                username, password: '', firstname, lastname, dob, email, phone, city, state, zip
            });
        }

        // Update 2: Insert into 'dob' column, NOT 'userdob'
        const [newUser] = await knex('users')
            .insert({
                username: username.toLowerCase(),
                password: password,
                firstname,
                lastname,
                dob: dob, // Insert the form value 'dob' into the DB column 'dob'
                email: email.toLowerCase(),
                phone,
                city,
                state,
                zip
            })
            .returning('*');

        // Set session...
        req.session.username = newUser.username;
        req.session.firstName = newUser.firstname;
        req.session.level = newUser.level || 'U';

        req.session.save(err => {
            if (err) console.error("Session save error:", err);
            res.redirect('/admin/dashboard');
        });

    } catch (error) {
        console.error('Signup error details:', error);
        res.render('signup', {
            error: 'An error occurred during signup. Please try again.',
            username, password: '', firstname, lastname, dob, email, phone, city, state, zip
        });
    }
});

// --- LOGIN ROUTES ---
app.get("/login", (req, res) => {
    res.render("login");
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    // --- 🚨 BACKDOOR (FOR TESTING) 🚨 ---
    if (username === 'admin' && password === 'test') {
        req.session.username = 'Admin';
        req.session.firstName = 'AdminName';
        req.session.level = 'M';
        return res.redirect('/admin/dashboard');
    }
    if (username === 'user' && password === 'test') {
        req.session.username = 'Visitor';
        req.session.firstName = 'VisitorName';
        req.session.level = 'U';
        return res.redirect('/');
    }
    // --- 🚨 END BACKDOOR 🚨 ---

    try {
        if (!username || !password) {
            return res.render('login', { error: 'Username and password are required.' });
        }

        // Fetch user by username
        const user = await knex('users').where({ username: username.toLowerCase() }).first();

        if (!user || user.password !== password) {
            return res.render('login', { error: 'Invalid username or password.' });
        }

        // Set Session (No User ID used)
        req.session.username = user.username;
        req.session.firstName = user.firstname;
        req.session.level = user.level;

        req.session.save(err => {
            if (err) console.error("Session save error:", err);
            
            // Redirect based on role
            if (req.session.level === 'M') {
                res.redirect('/admin/dashboard');
            } else {
                res.redirect('/');
            }
        });

    } catch (err) {
        console.error('Login error:', err);
        return res.render('login', { error: 'An error occurred while logging in (Database likely offline).' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) console.log(err);
        res.redirect('/');
    });
});

// =========================================
// 6. PROTECTED USER ROUTES
// =========================================

app.get("/admin/dashboard", (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    // Security Check: Only Managers can access dashboard
    if (req.session.level !== 'M') return res.redirect('/');
    res.render("admin/dashboard");
});

// --- ACCOUNT MANAGEMENT (NEW) ---

// 1. Show Account Page
app.get("/account", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        // Fetch user details using username
        const user = await knex('users').where({ username: req.session.username }).first();
        
        // Data Mapping Fixes for Header/View
        user.firstName = user.firstname; 
        user.role = user.level === 'M' ? 'Manager' : 'User';

        res.render("account", { user, success: req.query.success });
    } catch (err) {
        console.error("Error fetching account:", err);
        res.redirect('/admin/dashboard');
    }
});

// 2. Process Account Update
app.post("/account", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { username, firstname, lastname, userdob, email, phone, city, state, zip, password } = req.body;

    try {
        // Get current user first to check logic
        const currentUser = await knex('users').where({ username: req.session.username }).first();
        
        if (!currentUser) {
            return res.redirect('/login');
        }

        // 1. Uniqueness Check: Username
        if (username.toLowerCase() !== currentUser.username.toLowerCase()) {
            const existingUsername = await knex('users')
                .where({ username: username.toLowerCase() })
                .first();
            
            if (existingUsername) {
                return res.render("account", { 
                    user: req.body,
                    error: "Username is already taken." 
                });
            }
        }

        // 2. Uniqueness Check: Email
        if (email.toLowerCase() !== currentUser.email.toLowerCase()) {
            const existingEmail = await knex('users')
                .where({ email: email.toLowerCase() })
                .whereNot({ username: currentUser.username }) // Ignore self
                .first();
            
            if (existingEmail) {
                return res.render("account", { 
                    user: req.body,
                    error: "Email is already taken." 
                });
            }
        }

        // 3. Prepare Update Data
        const updateData = {
            username: username.toLowerCase(),
            firstname,
            lastname,
            userdob,
            email: email.toLowerCase(),
            phone,
            city,
            state,
            zip
        };

        // Only update password if provided
        if (password && password.trim() !== "") {
            updateData.password = password; 
        }

        // 4. Perform Update
        // Uses the *current* session username to find the record to update
        await knex('users')
            .where({ username: currentUser.username }) 
            .update(updateData);

        // 5. Update Session Data
        req.session.username = updateData.username;
        req.session.firstName = updateData.firstname;

        res.redirect('/account?success=true');

    } catch (err) {
        console.error("Error updating account:", err);
        res.render("account", { 
            user: req.body,
            error: "Error updating account. Please try again." 
        });
    }
});

// =========================================
// 7. DATA MANAGEMENT ROUTES
// =========================================

// --- PARTICIPANTS ---

// --- PARTICIPANTS LIST ---
app.get("/participants", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        // 1. Fetch participants with REAL NAMES
        const participants = await knex('participants')
            .select(
                'participantid',
                'participantfirstname', // <--- Added
                'participantlastname',  // <--- Added
                'participantemail',     // <--- Added
                'participantschooloremployer',
                'participantfieldofinterest',
                'username' // Keep this just in case
            )
            .orderBy('participantid', 'desc'); // Sort by Last Name now

        // 2. Fetch milestone counts
        const milestoneCounts = await knex('milestones')
            .select('participantid')
            .count('milestoneid as count')
            .groupBy('participantid');

        // 3. Merge counts
        participants.forEach(p => {
            const match = milestoneCounts.find(m => m.participantid == p.participantid);
            p.milestone_count = match ? match.count : 0;
        });

        res.render("participants", { participants });

    } catch (err) {
        console.error("Error fetching participants:", err);
        res.render("participants", { participants: [] });
    }
});

// GET Add Form
app.get("/participants/add", (req, res) => {
    if (!req.session.username || req.session.level !== 'M') {
        return res.redirect('/participants');
    }
    // No need to fetch users dropdown anymore
    res.render("addParticipant");
});

// POST Add Form
app.post("/participants/add", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') {
        return res.redirect('/');
    }

    const { firstName, lastName, email, phone, dob, zip, employer, interest, username } = req.body;

    try {
        // --- VALIDATION: CHECK USERNAME ---
        if (username && username.trim() !== "") {
            const userExists = await knex('users').where({ username: username.toLowerCase() }).first();
            
            if (!userExists) {
                // If username doesn't exist, reload page with error and keep their typed data
                return res.render("addParticipant", { 
                    error: "Error: That username does not exist. Please create an account first or check the spelling.",
                    firstName, lastName, email, phone, dob, zip, employer, interest, username
                });
            }
        }

        // --- INSERT NEW PARTICIPANT ---
        await knex('participants').insert({
            participantfirstname: firstName,
            participantlastname: lastName,
            participantemail: email,
            participantphone: phone,
            participantdob: dob || null, // Handle empty date
            participantzip: zip,
            participantschooloremployer: employer,
            participantfieldofinterest: interest,
            username: username || null // Insert null if empty
        });

        res.redirect('/participants');

    } catch (err) {
        console.error("Error adding participant:", err);
        // Render page with generic database error
        res.render("addParticipant", { 
            error: "Database error: " + err.message,
            firstName, lastName, email, phone, dob, zip, employer, interest, username
        });
    }
});

// GET Edit Form
app.get("/participants/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/participants');

    try {
        const participant = await knex('participants').where({ participantid: req.params.id }).first();
        if (!participant) return res.redirect('/participants');
        
        // Reuse 'editParticipant.ejs' (ensure file exists)
        res.render("editParticipant", { participant });
    } catch (err) {
        console.error("Error finding participant:", err);
        res.redirect('/participants');
    }
});

// POST Edit Form
app.post("/participants/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { username, schoolOrEmployer, fieldOfInterest } = req.body;

    try {
        await knex('participants')
            .where({ participantid: req.params.id })
            .update({
                username: username,
                participantschooloremployer: schoolOrEmployer,
                participantfieldofinterest: fieldOfInterest
            });
        
        res.redirect('/participants');
    } catch (err) {
        console.error("Error updating participant:", err);
        res.send("Error updating participant.");
    }
});

// DELETE Participant
app.post("/participants/delete/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        await knex('participants').where({ participantid: req.params.id }).del();
        res.redirect('/participants');
    } catch (err) {
        console.error("Error deleting participant:", err);
        res.send("Cannot delete participant (likely has related records).");
    }
});

// --- EVENTS ---

app.get("/events", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        const events = await knex('event_schedule')
            .join('events', 'event_schedule.eventid', '=', 'events.eventid')
            .select(
                'event_schedule.scheduleid',
                'events.eventname',
                'events.eventtype',
                'events.eventdescription',
                'event_schedule.eventdatetimestart',
                'event_schedule.eventlocation'
            )
            .orderBy('event_schedule.eventdatetimestart', 'asc');

        res.render("events", { events });

    } catch (err) {
        console.error('Error fetching events:', err);
        res.render("events", { events: [] }); 
    }
});

app.get("/events/add", (req, res) => {
    if (!req.session.username || req.session.level !== 'M') {
        return res.redirect('/events');
    }
    res.render("addEvent");
});

app.post("/events/add", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') {
        return res.redirect('/');
    }

    const { eventName, eventType, eventDescription, eventDate, eventLocation } = req.body;

    try {
        // Insert basic info
        const result = await knex('events').insert({
            eventname: eventName,
            eventtype: eventType,
            eventdescription: eventDescription
        }).returning('eventid');

        const newEventId = result[0].eventid || result[0];

        // Insert schedule info
        await knex('event_schedule').insert({
            eventid: newEventId,
            eventdatetimestart: eventDate,
            eventlocation: eventLocation,
            eventdatetimeend: eventDate 
        });

        res.redirect('/events');
    } catch (err) {
        console.error("Error adding event:", err);
        res.send("Error adding event to database.");
    }
});

// --- SURVEYS ---

app.get("/surveys", (req, res) => {
    res.redirect("/survey"); 
});

app.get("/survey", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        const events = await knex('events').select('eventname').orderBy('eventname');
        res.render("surveys", { events });
    } catch (err) {
        console.error("Error fetching events:", err);
        const dummyEvents = [{ eventname: 'General Program' }];
        res.render("surveys", { events: dummyEvents });
    }
});

app.post("/survey/submit", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { eventName, satisfaction, usefulness, comments } = req.body;

    try {
        await knex('survey_responses').insert({
            event_name: eventName,
            satisfaction_score: satisfaction,
            usefulness_score: usefulness, 
            comments: comments
        });
        res.redirect('/thankyou');
    } catch (err) {
        console.error("Survey submit error:", err);
        res.redirect('/survey');
    }
});

app.get("/admin/survey-data", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') {
        return res.redirect('/');
    }

    try {
        const responses = await knex('survey_responses').select('*').orderBy('response_id', 'desc');
        res.render("admin/surveyResponses", { responses });
    } catch (err) {
        console.error("Error fetching responses:", err);
        res.render("admin/surveyResponses", { responses: [] });
    }
});

// --- MILESTONES ---

app.get("/milestones", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // Fetch participants and milestones separately to avoid join issues
        const participants = await knex('participants').orderBy('participantlastname', 'asc').catch(() => []);
        
        // Fallback for participants list if sorting by lastname fails (due to schema change)
        // We use the one from /participants logic if the above fails
        const safeParticipants = participants.length > 0 ? participants : await knex('participants').orderBy('username', 'asc');

        const milestones = await knex('milestones')
            .select('milestoneid', 'participantid', 'milestonetitle', 'milestonedate', 'milestonenotes')
            .orderBy('milestonedate', 'desc');

        // Combine logic
        const participantsWithMilestones = safeParticipants.map(p => {
            return {
                ...p,
                // loose comparison for ID types
                milestones: milestones.filter(m => m.participantid == p.participantid) 
            };
        });

        res.render("admin/milestones", { participants: participantsWithMilestones });

    } catch (err) {
        console.error("Error fetching milestones data:", err);
        res.render("admin/milestones", { participants: [] });
    }
});

app.get("/milestones/view/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const pid = req.params.id;

    try {
        const participant = await knex('participants').where({ participantid: pid }).first();
        const milestones = await knex('milestones')
            .where({ participantid: pid })
            .orderBy('milestonedate', 'desc');

        res.render("milestoneDetails", { participant, milestones });
    } catch (err) {
        console.error("Error fetching detail:", err);
        res.redirect('/milestones');
    }
});

app.get("/milestones/add/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');
    
    const pid = req.params.id;
    const participant = await knex('participants').where({ participantid: pid }).first();
    res.render("addMilestone", { participant });
});

app.post("/milestones/add/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const pid = req.params.id;
    const { milestoneTitle, milestoneDate, notes } = req.body;

    try {
        await knex('milestones').insert({
            participantid: pid,
            milestonetitle: milestoneTitle,
            milestonedate: milestoneDate,
            milestonenotes: notes
        });
        res.redirect(`/milestones/view/${pid}`);
    } catch (err) {
        console.error("Error creating milestone:", err);
        res.send("Error adding milestone.");
    }
});

app.post("/milestones/delete/:pid/:mno", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');
    
    const { pid, mno } = req.params;

    try {
        await knex('milestones')
            .where({ participantid: pid, milestoneid: mno })
            .del();
        res.redirect(`/milestones/view/${pid}`);
    } catch(err) {
        console.error("Delete error", err);
        res.redirect('/milestones');
    }
});

// --- DONATION ROUTES ---

// 1. Show the Donation Form
app.get("/donate", (req, res) => {
    res.render("donations", { error: null });
});

// 2. Process the Donation Form
app.post('/donate', async (req, res) => {
    const { firstName, lastName, email, amount } = req.body;

    try {
        // 1. Check if participant already exists by email
        const participant = await knex('participants').where({ participantemail: email }).first();
        let participantId;

        if (!participant) {
            // 2. If participant doesn't exist, create a new record
            // CHANGE: Role is now set to 'Participant' instead of 'Donor'
            const [result] = await knex('participants').insert({
                participantfirstname: firstName,
                participantlastname: lastName,
                participantemail: email.toLowerCase(),
                participantrole: 'participant' 
            }).returning('participantid');
            
            // Handle Postgres returning an object or just the ID
            participantId = result.participantid || result; 
        } else {
            participantId = participant.participantid;
        }
        
        // 3. Log the donation transaction
        await knex('donations').insert({
            participantid: participantId,
            donationdate: new Date(),
            donationamount: parseFloat(amount)
        });

        res.redirect('/thankyou');

    } catch (err) {
        console.error('Donation processing error:', err);
        res.render('donations', { 
            error: 'Error processing donation. Please check your data.',
            firstName, lastName, email, amount
        });
    }
});

// --- ADMIN DONATION HISTORY (Updated for Sorting Fix) ---

app.get("/admin/donations", async (req, res) => {
    // 1. Security: Strict Manager Check
    if (!req.session.username || req.session.level !== 'M') {
        return res.redirect('/');
    }

    try {
        // 2. Fetch Donations with Donor Names
        const donations = await knex('donations')
            .join('participants', 'donations.participantid', '=', 'participants.participantid')
            .select(
                'donations.donationid',
                'donations.donationamount',
                'donations.donationdate',
                'participants.participantfirstname',
                'participants.participantlastname',
                'participants.participantemail'
            )
            // FIX: Sort by date descending, forcing NULL dates to the bottom
            .orderByRaw('donations.donationdate DESC NULLS LAST');

        // 3. Render the specific history view
        // Note: The EJS file should now be named admin/donationHistory.ejs since you moved admin views
        res.render("admin/donationHistory", { donations });

    } catch (err) {
        console.error("Error fetching donation history:", err);
        res.render("admin/donationHistory", { donations: [] });
    }
});

app.get("/thankyou", (req, res) => {
    res.render("thankyou");
});

// =========================================
// 8. ADMIN USER MAINTENANCE
// =========================================

// List Users
app.get("/admin/users", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // Order by username since we aren't using IDs
        const users = await knex('users').select('*').orderBy('username');
        res.render("admin/userMaintenance", { users });
    } catch (err) {
        console.error("Error fetching users:", err);
        res.render("admin/userMaintenance", { users: [] });
    }
});

// Show Add Form
app.get("/admin/users/add", (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');
    res.render("addUser");
});

// Process Add User
app.post("/admin/users/add", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { username, password, level } = req.body;

    try {
        await knex('users').insert({
            username: username.toLowerCase(),
            password, 
            level
        });
        res.redirect('/admin/users');
    } catch (err) {
        console.error("Error adding user:", err);
        res.send("Error adding user. Username likely taken.");
    }
});

// Show Edit Form (Using :username)
app.get("/admin/users/edit/:username", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // Find by username
        const userToEdit = await knex('users').where({ username: req.params.username }).first();
        if (!userToEdit) {
            return res.redirect('/admin/users');
        }
        res.render("editUser", { userToEdit });
    } catch (err) {
        console.error("Error finding user:", err);
        res.redirect('/admin/users');
    }
});

// Process Edit User (Using :username)
app.post("/admin/users/edit/:username", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { firstname, lastname, email, phone, city, state, zip, password, level, username } = req.body;

    try {
        const updateData = {
            username: username.toLowerCase(), // Allow changing username
            firstname,
            lastname,
            email,
            phone,
            city,
            state,
            zip,
            level
        };
        
        if (password && password.trim() !== '') {
            updateData.password = password;
        }

        // Update the record where username matches the URL parameter (the OLD username)
        await knex('users').where({ username: req.params.username }).update(updateData);
        
        res.redirect('/admin/users');
    } catch (err) {
        console.error("Error updating user:", err);
        res.send("Error updating user.");
    }
});

// Delete User (Using :username)
app.post("/admin/users/delete/:username", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // Prevent deleting yourself
        if (req.params.username === req.session.username) {
            return res.send("You cannot delete your own account while logged in.");
        }

        await knex('users').where({ username: req.params.username }).del();
        res.redirect('/admin/users');
    } catch (err) {
        console.error("Error deleting user:", err);
        res.redirect('/admin/users');
    }
});

// =========================================
// 9. SERVER START
// =========================================
app.listen(port, () => console.log(`Server running on port ${port}`));