require('dotenv').config();
const express = require("express");
const session = require("express-session");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

// --- 1. APP CONFIGURATION ---
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// Parse form data
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- 2. DATABASE CONNECTION (Knex) ---
const knex = require("knex")({
  client: "pg",
  connection: {
    host: process.env.RDS_HOSTNAME || "localhost",
    user: process.env.RDS_USERNAME || "postgres",
    password: process.env.RDS_PASSWORD || "YLj13cO1",
    database: process.env.RDS_DB_NAME || "ebdb",
    port: process.env.RDS_PORT || 5432,
    ssl: process.env.DB_SSL ? { rejectUnauthorized: false } : false // Force SSL
  }
});

// --- 3. SESSION SETUP ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if you switch to HTTPS
}));

// --- 4. GLOBAL USER MIDDLEWARE ---
app.use((req, res, next) => {
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

// --- 5. ROUTES ---

// Public Pages
app.get("/", (req, res) => {
    res.render("index");
});

app.get("/signup", (req, res) => {
    res.render("signup");
});

app.post('/signup', async (req, res) => {
    const { username, password, firstname, lastname, userdob, email, phone, city, state, zip } = req.body;
 
    try {
        // Check if user already exists (by email or username)
        const existingUser = await knex('users')
            .where('email', email.toLowerCase())
            .orWhere('username', username.toLowerCase())
            .first();
 
        if (existingUser) {
            return res.render('signup', {
                error: 'An account with this email or username already exists',
                username,
                password: '',
                firstname,
                lastname,
                userdob,
                email,
                phone,
                city,
                state,
                zip
            });
        }
 
        // Insert new user into database (plain password)
        const [newUser] = await knex('users')
            .insert({
                username: username.toLowerCase(),
                password: password,  // Plain text
                firstname,
                lastname,
                userdob,
                email: email.toLowerCase(),
                phone,
                city,
                state,
                zip
            })
            .returning('*');
 
        // Set up session
        req.session.userId = newUser.id;
        req.session.userEmail = newUser.email;
        req.session.username = newUser.username;
 
        res.redirect('/dashboard');
 
    } catch (error) {
        console.error('Signup error details:', {
            message: error.message,
            code: error.code,
            constraint: error.constraint,
            table: error.table,
            stack: error.stack
        });
        res.render('signup', {
            error: 'An error occurred during signup. Please try again.',
            username,
            password: '',
            firstname,
            lastname,
            userdob,
            email,
            phone,
            city,
            state,
            zip
        });
    }
});



// --- DONATION ROUTES ---

// 1. Show the Donation Form
app.get("/donate", (req, res) => {
    res.render("donations");
});

// 2. Process the Donation Form
app.post('/donate', async (req, res) => {
    const { firstName, lastName, email, amount } = req.body;

    try {
        const participant = await knex('participants').where({ ParticipantEmail: email }).first();
        let participantId;

        if (!participant) {
            const result = await knex('participants').insert({
                ParticipantFirstName: firstName,
                ParticipantLastName: lastName,
                ParticipantEmail: email,
                ParticipantRole: 'Donor'
            }).returning('ParticipantID');
            
            participantId = result[0].ParticipantID || result[0]; 
        } else {
            participantId = participant.ParticipantID;
        }
        
        await knex('donations').insert({
            ParticipantID: participantId,
            DonationDate: new Date(),
            DonationAmount: amount
        });

        res.redirect('/thankyou');

    } catch (err) {
        console.error('Donation processing error:', err);
        res.render('donations', { error: 'Error processing donation. Please try again.' });
    }
});

// --- ADMIN DONATION HISTORY ---

app.get("/admin/donations", async (req, res) => {
    // 1. Security: Strict Manager Check
    if (!req.session.username || req.session.level !== 'M') {
        return res.redirect('/');
    }

    try {
        // 2. Fetch Donations with Donor Names
        // We join 'donations' with 'participants' so we see names, not just IDs
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
            .orderBy('donations.donationdate', 'desc'); // Newest first

        // 3. Render the specific history view you created
        res.render("donationHistory", { donations });

    } catch (err) {
        console.error("Error fetching donation history:", err);
        // If the table is missing, show empty list so it doesn't crash
        res.render("donationHistory", { donations: [] });
    }
});

// 3. Thank You Page
app.get("/thankyou", (req, res) => {
    res.render("thankyou");
});

// --- LOGIN ROUTES ---

app.get("/login", (req, res) => {
    res.render("login");
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    // --- 🚨 BACKDOOR (DELETE BEFORE SUBMISSION) 🚨 ---
    if (username === 'admin' && password === 'test') {
        req.session.userId = 888;
        req.session.username = 'Admin';
        req.session.firstName = 'AdminName';
        req.session.level = 'M'; 
        return res.redirect('/dashboard'); 
    }
    if (username === 'user' && password === 'test') {
        req.session.userId = 999;
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

        const user = await knex('users').where({ username }).first();

        if (!user || user.password !== password) {
            return res.render('login', { error: 'Invalid username or password.' });
        }

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.firstName = user.firstname;
        req.session.level = user.level;

        if (req.session.level === 'M') {
            return res.redirect('/dashboard');
        } else {
            return res.redirect('/');
        }

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

// --- PROTECTED DATA ROUTES ---

app.get("/dashboard", (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    if (req.session.level !== 'M') return res.redirect('/');
    res.render("dashboard");
});

// --- PARTICIPANT ROUTES ---

app.get("/participants", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        // 1. Fetch participants (Corrected Schema)
        const participants = await knex('participants')
            .select(
                'participantid',
                'username',
                'participantschooloremployer',
                'participantfieldofinterest'
            )
            .orderBy('username', 'asc'); // Sorted by username since lastname doesn't exist

        // 2. Fetch milestone counts separately
        const milestoneCounts = await knex('milestones')
            .select('participantid')
            .count('milestoneno as count')
            .groupBy('participantid');

        // 3. Merge counts in JavaScript (Avoids Type Mismatch)
        participants.forEach(p => {
            // loose comparison (==) handles int vs string ID mismatch
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
    // Note: You may need to update 'addParticipant.ejs' to match these new fields later
    res.render("addParticipant");
});

// POST Add Form (Updated for new schema)
app.post("/participants/add", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') {
        return res.redirect('/');
    }

    // Expecting these fields from your form now
    const { username, schoolOrEmployer, fieldOfInterest } = req.body;

    try {
        await knex('participants').insert({
            username: username,
            participantschooloremployer: schoolOrEmployer,
            participantfieldofinterest: fieldOfInterest
        });
        res.redirect('/participants');
    } catch (err) {
        console.error("Error adding participant:", err);
        res.send("Error adding participant. Check server logs.");
    }
});

// GET Edit Form
app.get("/participants/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/participants');

    try {
        const participant = await knex('participants').where({ participantid: req.params.id }).first();
        if (!participant) return res.redirect('/participants');
        
        // Ensure you create/update 'editParticipant.ejs' to have inputs for username, school, interest
        res.render("editParticipant", { participant });
    } catch (err) {
        console.error("Error finding participant:", err);
        res.redirect('/participants');
    }
});

// POST Edit Form (Updated for new schema)
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

// --- EVENT ROUTES ---

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
        const result = await knex('events').insert({
            eventname: eventName,
            eventtype: eventType,
            eventdescription: eventDescription
        }).returning('eventid');

        const newEventId = result[0].eventid || result[0];

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

// --- SURVEY ROUTES (CLEANED) ---

app.get("/surveys", (req, res) => {
    // Redirects any traffic trying to reach the plural URL to the official singular URL
    res.redirect("/survey"); 
});

app.get("/survey", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        // Fetch event names for dropdown
        const events = await knex('events').select('eventname').orderBy('eventname');
        
        // RENDER 'surveys.ejs' (The form file)
        res.render("surveys", { events });
        
    } catch (err) {
        console.error("Error fetching events:", err);
        // Fallback if DB fails
        const dummyEvents = [{ eventname: 'General Program' }];
        res.render("surveys", { events: dummyEvents });
    }
});

// 2. SUBMIT THE FORM
app.post("/survey/submit", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { eventName, satisfaction, usefulness, comments } = req.body;

    try {
        // Insert into DB
        await knex('survey_responses').insert({
            event_name: eventName,
            satisfaction_score: satisfaction,
            usefulness_score: usefulness, 
            comments: comments
        });

        res.redirect('/thankyou');

    } catch (err) {
        console.error("Survey submit error:", err);
        // On error, redirect back to form
        res.redirect('/survey');
    }
});

// 3. ADMIN VIEW RESPONSES (Manager Only)
app.get("/admin/survey-data", async (req, res) => {
    // Strict Manager Check
    if (!req.session.username || req.session.level !== 'M') {
        return res.redirect('/');
    }

    try {
        const responses = await knex('survey_responses').select('*').orderBy('response_id', 'desc'); // check your primary key name
        res.render("surveyResponses", { responses });
    } catch (err) {
        console.error("Error fetching responses:", err);
        res.render("surveyResponses", { responses: [] });
    }
});

// --- OTHER DATA ROUTES ---

// 1. VIEW MILESTONE MANAGEMENT PAGE (Manager Only)
app.get("/milestones", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // 1. Fetch all participants
        const participants = await knex('participants')
            .orderBy('participantlastname', 'asc');

        // 2. Fetch all milestones (using correct column names from your image)
        const milestones = await knex('milestones')
            .select('milestoneno', 'participantid', 'milestonetitle', 'milestonedate', 'milestonenotes')
            .orderBy('milestonedate', 'desc');

        // 3. Combine them: Attach milestones to each participant object
        const participantsWithMilestones = participants.map(p => {
            return {
                ...p,
                milestones: milestones.filter(m => m.participantid === p.participantid)
            };
        });

        res.render("milestones", { participants: participantsWithMilestones });

    } catch (err) {
        console.error("Error fetching milestones data:", err);
        res.render("milestones", { participants: [] });
    }
});

// --- MILESTONE DETAIL & MAINTENANCE ROUTES ---

// 2. VIEW DETAILS (Specific Participant's History)
app.get("/milestones/view/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const pid = req.params.id;

    try {
        const participant = await knex('participants').where({ participantid: pid }).first();
        
        // Updated to use 'milestonedate' and 'milestoneno'
        const milestones = await knex('milestones')
            .where({ participantid: pid })
            .orderBy('milestonedate', 'desc');

        res.render("milestoneDetails", { participant, milestones });

    } catch (err) {
        console.error("Error fetching detail:", err);
        res.redirect('/milestones');
    }
});

// 3. SHOW ADD FORM
app.get("/milestones/add/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');
    
    const pid = req.params.id;
    const participant = await knex('participants').where({ participantid: pid }).first();
    
    res.render("addMilestone", { participant });
});

// 4. PROCESS ADD FORM
app.post("/milestones/add/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const pid = req.params.id;
    // Note: 'milestoneno' is likely an integer. 
    // If it's not auto-incrementing in DB, you might need to calculate the next number here.
    // Assuming DB handles it or you input it manually. 
    const { milestoneTitle, milestoneDate, notes } = req.body;

    try {
        await knex('milestones').insert({
            participantid: pid,
            milestonetitle: milestoneTitle, // Corrected column
            milestonedate: milestoneDate,   // Corrected column
            milestonenotes: notes          // Corrected column
        });

        res.redirect(`/milestones/view/${pid}`);

    } catch (err) {
        console.error("Error creating milestone:", err);
        res.send("Error adding milestone. Check DB constraints.");
    }
});

// 5. DELETE MILESTONE 
// NOTE: Because your table uses a Composite PK (milestoneno + participantid), 
// we need both to delete safely.
app.post("/milestones/delete/:pid/:mno", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');
    
    const { pid, mno } = req.params;

    try {
        await knex('milestones')
            .where({ participantid: pid, milestoneno: mno }) // Match both keys
            .del();
        
        res.redirect(`/milestones/view/${pid}`);
    } catch(err) {
        console.error("Delete error", err);
        res.redirect('/milestones');
    }
});


app.get("/donations", (req, res) => {
    // Check if user is logged in
        knex.select().from("users")
            .then(users => {
                console.log(`Successfully retrieved ${users.length} users from database`);
                res.render("donations", {users: users});
            })
            .catch((err) => {
                console.error("Database query error:", err.message);
                res.render("donations", {
                    users: [],
                    error_message: `Database error: ${err.message}. Please check if the 'users' table exists.`
                });
            });
});

// --- ADMIN ROUTES ---

app.get("/admin", (req, res) => {
    if (req.session.level !== 'M') return res.redirect('/');
    res.render("admin");
});

// --- USER MAINTENANCE ROUTES (Admin Only) ---

// 1. LIST ALL USERS
app.get("/admin/users", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // Ensure we order by 'id', not 'userID'
        const users = await knex('users').select('*').orderBy('id');
        res.render("userMaintenance", { users });
    } catch (err) {
        console.error("Error fetching users:", err);
        res.render("userMaintenance", { users: [] });
    }
});

// 2. SHOW ADD USER FORM
app.get("/admin/users/add", (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');
    res.render("addUser");
});

// 3. PROCESS ADD USER
app.post("/admin/users/add", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { username, password, level } = req.body;

    try {
        await knex('users').insert({
            username: username.toLowerCase(),
            password, 
            level // 'M' or 'U'
        });
        res.redirect('/admin/users');
    } catch (err) {
        console.error("Error adding user:", err);
        res.send("Error adding user.");
    }
});

// 4. DISPLAY EDIT USER FORM (Changed :userID to :id)
app.get("/admin/users/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // Changed .where({ userID: ... }) to .where({ id: ... })
        const userToEdit = await knex('users').where({ id: req.params.id }).first();
        if (!userToEdit) {
            return res.redirect('/admin/users');
        }
        res.render("editUser", { userToEdit });
    } catch (err) {
        console.error("Error finding user:", err);
        res.redirect('/admin/users');
    }
});

// 5. PROCESS EDIT USER (Changed :userID to :id)
app.post("/admin/users/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { firstname, lastname, email, phone, city, state, zip, password, level } = req.body;

    try {
        const updateData = {
            firstname,
            lastname,
            email,
            phone,
            city,
            state,
            zip,
            level
        };
        
        // Only update password if provided
        if (password && password.trim() !== '') {
            updateData.password = password;
        }

        // Changed .where({ userID: ... }) to .where({ id: ... })
        await knex('users').where({ id: req.params.id }).update(updateData);
        res.redirect('/admin/users');
    } catch (err) {
        console.error("Error updating user:", err);
        res.send("Error updating user.");
    }
});

// 6. DELETE USER (Changed :userID to :id)
app.post("/admin/users/delete/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // Prevent deleting yourself!
        // Changed req.params.userID to req.params.id
        if (req.session.userId == req.params.id) {
            return res.send("You cannot delete your own account while logged in.");
        }

        // Changed .where({ userID: ... }) to .where({ id: ... })
        await knex('users').where({ id: req.params.id }).del();
        res.redirect('/admin/users');
    } catch (err) {
        console.error("Error deleting user:", err);
        res.redirect('/admin/users');
    }
});

app.get("/teapot", (req, res) => {
    res.status(418).send("418: I'm a little Teapot (Short and stout)");
});

// --- ACCOUNT MANAGEMENT ROUTES ---

// 1. Show Account Page
app.get("/account", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        const user = await knex('users').where({ username: req.session.username }).first();
        res.render("account", { user, success: req.query.success });
    } catch (err) {
        console.error("Error fetching account:", err);
        res.redirect('/dashboard');
    }
});

app.post("/account", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { username, firstname, lastname, userdob, email, phone, city, state, zip, password } = req.body;

    try {
        // Get current user first
        const currentUser = await knex('users').where({ username: req.session.username }).first();
        
        if (!currentUser) {
            console.log("Current user not found");
            return res.redirect('/login');
        }

        // Check if new username is taken by someone else
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

        // Check if new email is taken by someone else
        if (email.toLowerCase() !== currentUser.email.toLowerCase()) {
            const existingEmail = await knex('users')
                .where({ email: email.toLowerCase() })
                .whereNot({ username: currentUser.username })
                .first();
            
            if (existingEmail) {
                return res.render("account", { 
                    user: req.body,
                    error: "Email is already taken." 
                });
            }
        }

        const updateData = {
            firstname,
            lastname,
            userdob,
            email: email.toLowerCase(),
            phone,
            city,
            state,
            zip
        };

        // Only update password if they typed something new
        if (password && password.trim() !== "") {
            updateData.password = password; 
        }

        // If username is changing, we need to handle it differently
        if (username.toLowerCase() !== currentUser.username.toLowerCase()) {
            // Delete old record and insert new one with new username
            await knex.transaction(async (trx) => {
                const userData = { ...currentUser, ...updateData, username: username.toLowerCase() };
                await trx('users').where({ username: currentUser.username }).del();
                await trx('users').insert(userData);
            });
        } else {
            // Just update the existing record
            await knex('users')
                .where({ username: currentUser.username })
                .update(updateData);
        }

        // Update session variables
        req.session.username = username.toLowerCase();
        req.session.firstName = updateData.firstname;

        res.redirect('/account?success=true');

    } catch (err) {
        console.error("Error updating account - Full error:", err);
        res.render("account", { 
            user: req.body,
            error: "Error updating account. Please try again." 
        });
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));