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

// --- PARTICIPANT ROUTES ---

app.get("/participants", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        const participants = await knex('participants')
            // FIX: Cast participantid to TEXT to match the milestones table type
            .leftJoin('milestones', knex.raw('CAST(participants.participantid AS TEXT)'), '=', 'milestones.participantid')
            .select(
                'participants.participantid',
                'participants.participantfirstname',
                'participants.participantlastname',
                'participants.participantemail',
                'participants.participantrole',
                'participants.participantcity',
                // NEW FIELDS ADDED HERE:
                'participants.participantschooloremployer',
                'participants.participantfieldofinterest',
                knex.raw('COUNT(milestones.milestoneno) as milestone_count')
            )
            .groupBy('participants.participantid')
            .orderBy('participants.participantlastname', 'asc');

        res.render("participants", { participants });

    } catch (err) {
        // IMPROVEMENT: Log the ACTUAL error so you can see it in your terminal
        console.error('Detailed Error fetching participants:',Vrerr);
        res.render("participants", { participants: [] });
    }
});

app.get("/participants/add", (req, res) => {
    if (!req.session.username || req.session.level !== 'M') {
        return res.redirect('/participants');
    }
    res.render("addParticipant");
});

app.post("/participants/add", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') {
        return res.redirect('/');
    }

    const { firstName, lastName, email, role, city } = req.body;

    try {
        await knex('participants').insert({
            participantfirstname: firstName,
            participantlastname: lastName,
            participantemail: email,
            participantrole: role,
            participantcity: city
        });
        res.redirect('/participants');
    } catch (err) {
        console.error("Error adding participant:", err);
        res.send("Error adding participant. Check server logs.");
    }
});

// --- NEW: EDIT PARTICIPANT (GET) ---
app.get("/participants/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/participants');

    try {
        const participant = await knex('participants').where({ participantid: req.params.id }).first();
        if (!participant) return res.redirect('/participants');
        
        // You will need to create 'editParticipant.ejs' similar to 'addParticipant.ejs'
        res.render("editParticipant", { participant });
    } catch (err) {
        console.error("Error finding participant:", err);
        res.redirect('/participants');
    }
});

// --- NEW: EDIT PARTICIPANT (POST) ---
app.post("/participants/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { firstName, lastName, email, role, city } = req.body;

    try {
        await knex('participants')
            .where({ participantid: req.params.id })
            .update({
                participantfirstname: firstName,
                participantlastname: lastName,
                participantemail: email,
                participantrole: role,
                participantcity: city
            });
        
        res.redirect('/participants');
    } catch (err) {
        console.error("Error updating participant:", err);
        res.send("Error updating participant.");
    }
});

// --- NEW: DELETE PARTICIPANT ---
app.post("/participants/delete/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // Note: This might fail if the participant has related donations/milestones 
        // unless you have ON DELETE CASCADE set up in your DB.
        await knex('participants').where({ participantid: req.params.id }).del();
        res.redirect('/participants');
    } catch (err) {
        console.error("Error deleting participant:", err);
        res.send("Cannot delete participant. They may have related donations or milestones.");
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
    // Security: Must be logged in, must be Manager
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // Query to get all participants and LEFT JOIN with Milestones
        // This ensures participants with zero milestones still appear
        const participantsWithMilestones = await knex('participants')
            .leftJoin('milestones', 'participants.participantid', '=', 'milestones.participantid')
            .select(
                'participants.participantid',
                'participants.participantfirstname',
                'participants.participantlastname',
                knex.raw('COUNT(milestones.milestoneid) AS total_milestones_achieved')
            )
            .groupBy('participants.participantid') // Group by participant to count milestones
            .orderBy('participants.participantlastname', 'asc');

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
        // A. Get the Participant Info
        const participant = await knex('participants').where({ participantid: pid }).first();
        
        // B. Get their Milestones
        const milestones = await knex('milestones')
            .where({ participantid: pid })
            .orderBy('dateachieved', 'desc');

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
    
    // We need the name to show on the form header ("Adding for Maria...")
    const participant = await knex('participants').where({ participantid: pid }).first();
    
    res.render("addMilestone", { participant });
});

// 4. PROCESS ADD FORM
app.post("/milestones/add/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const pid = req.params.id;
    const { milestoneName, dateAchieved, notes } = req.body;

    try {
        await knex('milestones').insert({
            participantid: pid,
            milestonename: milestoneName,
            dateachieved: dateAchieved,
            milestonenotes: notes
        });

        // Redirect back to that person's detail page
        res.redirect(`/milestones/view/${pid}`);

    } catch (err) {
        console.error("Error creating milestone:", err);
        res.send("Error adding milestone.");
    }
});

// 5. DELETE MILESTONE
app.post("/milestones/delete/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');
    
    const mid = req.params.id;
    // We need the participant ID to redirect back correctly
    const milestone = await knex('milestones').where({ milestoneid: mid }).first();
    const pid = milestone.participantid;

    await knex('milestones').where({ milestoneid: mid }).del();
    
    res.redirect(`/milestones/view/${pid}`);
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
            username,
            password, 
            level // 'M' or 'U'
        });
        res.redirect('/admin/users');
    } catch (err) {
        console.error("Error adding user:", err);
        res.send("Error adding user.");
    }
});

// 4. DISPLAY EDIT USER FORM
app.get("/admin/users/edit/:userID", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        const userToEdit = await knex('users').where({ userID: req.params.userID }).first();
        if (!userToEdit) {
            return res.redirect('/admin/users');
        }
        res.render("editUser", { userToEdit });
    } catch (err) {
        console.error("Error finding user:", err);
        res.redirect('/admin/users');
    }
});

// 5. PROCESS EDIT USER
app.post("/admin/users/edit/:userID", async (req, res) => {
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

        await knex('users').where({ userID: req.params.userID }).update(updateData);
        res.redirect('/admin/users');
    } catch (err) {
        console.error("Error updating user:", err);
        res.send("Error updating user.");
    }
});

// 6. DELETE USER
app.post("/admin/users/delete/:userID", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // Prevent deleting yourself!
        if (req.session.userID == req.params.userID) {
            return res.send("You cannot delete your own account while logged in.");
        }

        await knex('users').where({ userID: req.params.userID }).del();
        res.redirect('/admin/users');
    } catch (err) {
        console.error("Error deleting user:", err);
        res.redirect('/admin/users');
    }
});

app.get("/teapot", (req, res) => {
    res.status(418).send("418: I'm a little Teapot (Short and stout)");
});

app.listen(port, () => console.log(`Server running on port ${port}`));