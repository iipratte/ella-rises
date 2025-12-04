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
    // We get 'userdob' from the HTML form
    const { username, password, firstname, lastname, userdob, email, phone, city, state, zip, isParent, school, interest } = req.body;

    try {
        // 1. Check if user already exists
        const existingUser = await knex('users')
            .where('email', email.toLowerCase())
            .orWhere('username', username.toLowerCase())
            .first();

        if (existingUser) {
            return res.render('signup', {
                error: 'An account with this email or username already exists',
                username, firstname, lastname, userdob, email, phone, city, state, zip, school, interest
            });
        }

        // 2. Insert new user
        const [newUser] = await knex('users')
            .insert({
                username: username.toLowerCase(),
                password: password, 
                firstname,
                lastname,
                
                // ✅ FIX 1: Map the form field 'userdob' to the DB column 'dob'
                dob: userdob, 
                
                email: email.toLowerCase(),
                phone,
                city,
                state,
                zip,
                level: 'U',
                
                // ✅ FIX 2: Set Parent Flag (True if checked, False if not)
                parentflag: (isParent === 'on') 
            })
            .returning('*');

        // 3. Set Session
        req.session.userEmail = newUser.email;
        req.session.username = newUser.username;
        req.session.firstName = newUser.firstname;
        req.session.level = newUser.level;

        req.session.save(async (err) => {
            if (err) console.error("Session save error:", err);

            // 🛡️ ADD THIS: Start 'try' block to catch errors
            try {
                // LOGIC BRANCH
                if (isParent === 'on') {
                    // CASE A: PARENT -> Go to Add Participant (for their child)
                    res.redirect('/participants/add'); 

                } else {
                    // CASE B: STUDENT -> Auto-create Participant record
                    await knex('participants').insert({
                        username: newUser.username,
                        participantfirstname: newUser.firstname,
                        participantlastname: newUser.lastname,
                        participantemail: newUser.email,
                        participantphone: newUser.phone,
                        
                        // Use .dob (from database)
                        participantdob: newUser.dob, 
                        
                        participantzip: newUser.zip,
                        participantschooloremployer: school,
                        participantfieldofinterest: interest
                    });
                    res.redirect('/participants');
                }
            } catch (innerError) {
                // 🛡️ ADD THIS: Catch block to handle the error safely
                console.error("Auto-participant creation failed:", innerError);
                
                // Render the signup page with the error message instead of crashing
                return res.render('signup', { 
                    error: "Account created, but failed to join Participant list automatically. (Error: " + innerError.message + ")",
                    // Pass variables back to keep the form filled
                    username, firstname, lastname, userdob, email, phone, city, state, zip, school, interest
                });
            }
        });

    } catch (error) {
        console.error('Signup error details:', error);
        res.render('signup', {
            error: 'Signup Error: ' + error.message,
            username, firstname, lastname, userdob, email, phone, city, state, zip, school, interest
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

// --- ACCOUNT MANAGEMENT ROUTES ---

// 1. Show Account Page
app.get("/account", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        // 1. Fetch User Details
        const user = await knex('users').where({ username: req.session.username }).first();
        
        // 2. Fetch Linked Participant Details (for School/Interest fields)
        const participant = await knex('participants').where({ username: req.session.username }).first();

        // Data Mapping for Header/View
        user.firstName = user.firstname; 
        user.role = user.level === 'M' ? 'Manager' : 'User';

        // Pass both user and participant to the view
        res.render("account", { 
            user, 
            participant: participant || {}, // Pass empty object if no participant record exists
            success: req.query.success 
        });

    } catch (err) {
        console.error("Error fetching account:", err);
        res.redirect('/admin/dashboard');
    }
});

// 2. Process Account Update
app.post("/account", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { 
        username, firstname, lastname, userdob, email, phone, 
        city, state, zip, password, 
        schoolOrEmployer, fieldOfInterest // New fields from form
    } = req.body;

    try {
        // Get current user to check ID/ParentFlag
        const currentUser = await knex('users').where({ username: req.session.username }).first();
        
        if (!currentUser) {
            return res.redirect('/login');
        }

        // --- Uniqueness Checks (Username/Email) ---
        if (username.toLowerCase() !== currentUser.username.toLowerCase()) {
            const existingUsername = await knex('users').where({ username: username.toLowerCase() }).first();
            if (existingUsername) {
                return res.render("account", { 
                    user: req.body, 
                    participant: { participantschooloremployer: schoolOrEmployer, participantfieldofinterest: fieldOfInterest },
                    error: "Username is already taken." 
                });
            }
        }
        if (email.toLowerCase() !== currentUser.email.toLowerCase()) {
            const existingEmail = await knex('users').where({ email: email.toLowerCase() }).whereNot({ username: currentUser.username }).first();
            if (existingEmail) {
                return res.render("account", { 
                    user: req.body, 
                    participant: { participantschooloremployer: schoolOrEmployer, participantfieldofinterest: fieldOfInterest },
                    error: "Email is already taken." 
                });
            }
        }

        // --- 1. Update USERS Table ---
        const userUpdateData = {
            username: username.toLowerCase(),
            firstname,
            lastname,
            dob: userdob, // Map form 'userdob' to DB 'dob'
            email: email.toLowerCase(),
            phone,
            city,
            state,
            zip
        };

        if (password && password.trim() !== "") {
            userUpdateData.password = password; 
        }

        await knex('users')
            .where({ username: currentUser.username }) 
            .update(userUpdateData);

        // --- 2. Update PARTICIPANTS Table (If not a parent) ---
        // We check the flag on the currentUser we fetched at the start
        if (currentUser.parentflag === false || currentUser.parentflag === 0 || currentUser.parentflag === 'f') {
            await knex('participants')
                .where({ username: userUpdateData.username }) // Use new username in case it changed (assuming cascade worked or transaction)
                .update({
                    participantschooloremployer: schoolOrEmployer,
                    participantfieldofinterest: fieldOfInterest
                });
        }

        // Update Session
        req.session.username = userUpdateData.username;
        req.session.firstName = userUpdateData.firstname;

        res.redirect('/account?success=true');

    } catch (err) {
        console.error("Error updating account:", err);
        res.render("account", { 
            user: req.body, 
            participant: { participantschooloremployer: schoolOrEmployer, participantfieldofinterest: fieldOfInterest },
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

// 1. LIST ALL MILESTONES (With Search)
app.get("/milestones", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    // 1. Get search params from URL
    const { firstName, lastName } = req.query;

    try {
        // 2. Start building the query
        let query = knex('participants').orderBy('participantlastname', 'asc');

        // 3. Apply filters if user typed something
        if (firstName) {
            query = query.where('participantfirstname', 'ilike', `%${firstName}%`);
        }
        if (lastName) {
            query = query.where('participantlastname', 'ilike', `%${lastName}%`);
        }

        // 4. Execute the filtered query
        const participants = await query.catch(() => []);
        
        const safeParticipants = participants.length > 0 ? participants : [];

        // 5. Fetch all milestones
        const milestones = await knex('milestones')
            .select('milestoneid', 'participantid', 'milestonetitle', 'milestonedate', 'milestonenotes')
            .orderBy('milestonedate', 'desc');

        // 6. Combine logic
        const participantsWithMilestones = safeParticipants.map(p => {
            return {
                ...p,
                milestones: milestones.filter(m => m.participantid == p.participantid) 
            };
        });

        // CORRECTED RENDER PATH: "milestones", not "admin/milestones"
        res.render("milestones", { 
            participants: participantsWithMilestones,
            // Pass search terms back to keep inputs filled
            searchFirstName: firstName || '',
            searchLastName: lastName || ''
        });

    } catch (err) {
        console.error("Error fetching milestones data:", err);
        res.render("milestones", { 
            participants: [], 
            searchFirstName: '', 
            searchLastName: '' 
        });
    }
});

// 2. VIEW DETAILS (Specific Participant)
app.get("/milestones/view/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        const participant = await knex('participants').where({ participantid: req.params.id }).first();
        const milestones = await knex('milestones')
            .where({ participantid: req.params.id })
            .orderBy('milestonedate', 'desc');

        // Ensure this view exists in the right place (e.g., views/milestoneDetails.ejs)
        res.render("milestoneDetails", { participant, milestones });
    } catch (err) {
        console.error("Error fetching detail:", err);
        res.redirect('/milestones');
    }
});

// 3. ADD MILESTONE (GET)
app.get("/milestones/add/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');
    
    try {
        const participant = await knex('participants').where({ participantid: req.params.id }).first();
        res.render("addMilestone", { participant });
    } catch (err) {
        console.error("Error getting add form:", err);
        res.redirect('/milestones');
    }
});

// 4. ADD MILESTONE (POST)
app.post("/milestones/add/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { milestoneTitle, milestoneDate, notes } = req.body;

    try {
        await knex('milestones').insert({
            participantid: req.params.id,
            milestonetitle: milestoneTitle,
            milestonedate: milestoneDate,
            milestonenotes: notes
        });
        res.redirect('/milestones');
    } catch (err) {
        console.error("Error creating milestone:", err);
        res.send("Error adding milestone.");
    }
});

// 5. EDIT MILESTONE (GET) - NEW
app.get("/milestones/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        const milestone = await knex('milestones').where({ milestoneid: req.params.id }).first();
        if (!milestone) return res.redirect('/milestones');

        const participant = await knex('participants').where({ participantid: milestone.participantid }).first();
        
        res.render("editMilestone", { milestone, participant });
    } catch (err) {
        console.error("Error fetching milestone to edit:", err);
        res.redirect('/milestones');
    }
});

// 6. EDIT MILESTONE (POST) - NEW
app.post("/milestones/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { milestoneTitle, milestoneDate, notes } = req.body;

    try {
        await knex('milestones')
            .where({ milestoneid: req.params.id })
            .update({
                milestonetitle: milestoneTitle,
                milestonedate: milestoneDate,
                milestonenotes: notes
            });
        
        res.redirect('/milestones');
    } catch (err) {
        console.error("Error updating milestone:", err);
        res.send("Error updating milestone.");
    }
});

// 7. DELETE MILESTONE
app.post("/milestones/delete/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');
    
    try {
        // Delete by primary key (milestoneid)
        await knex('milestones').where({ milestoneid: req.params.id }).del();
        res.redirect('/milestones');
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
        .orderByRaw(`
            CASE
                WHEN donations.donationdate IS NULL THEN 2           -- nulls last
                WHEN donations.donationdate > CURRENT_DATE THEN 1    -- future dates in middle
                ELSE 0                                               -- past + today first
            END,
            donations.donationdate DESC
        `);
            
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