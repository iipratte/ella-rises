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
    host: process.env.RDS_HOSTNAME,
    user: process.env.RDS_USERNAME,
    password: process.env.RDS_PASSWORD,
    database: process.env.RDS_DB_NAME,
    port: process.env.RDS_PORT,
    ssl: { rejectUnauthorized: false, require: true } // Force SSL
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
        req.session.level = 'M'; 
        return res.redirect('/dashboard'); 
    }
    if (username === 'user' && password === 'test') {
        req.session.userId = 999;
        req.session.username = 'Visitor';
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
        const participants = await knex('participants')
            .select('*')
            .orderBy('participantlastname', 'asc');

        res.render("participants", { participants });

    } catch (err) {
        console.error('Error fetching participants:', err);
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

// --- SURVEY ROUTES (FIXED) ---

// 1. Survey List Page (The Grid of Options)
app.get("/surveys", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    
    // We try to get real data, but if it fails, we use dummy data
    try {
         const surveys = await knex('surveys').select('*');
         res.render("surveys", { surveys });
    } catch (err) {
        console.log("Using dummy survey data...");
        
        // UPDATE: Only show specific Post-Event surveys
        const dummySurveys = [
            { 
                surveyid: 1, 
                surveyname: 'Leadership Workshop Feedback', 
                surveydescription: 'Please rate your experience at the recent Leadership Summit.', 
                surveytype: 'Post-Event' 
            },
            { 
                surveyid: 2, 
                surveyname: 'Art Class Evaluation', 
                surveydescription: 'Feedback for the watercolor painting session.', 
                surveytype: 'Post-Event' 
            }
        ];
        res.render("surveys", { surveys: dummySurveys });
    }
});

// 2. Take Survey Page (The Form)
// app.js

// 1. Show the Generic Survey Form
app.get("/survey", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        // Fetch all event names to populate the dropdown
        const events = await knex('events').select('eventname').orderBy('eventname');
        
        // Render the form and pass the event list
        res.render("takeSurvey", { events });

    } catch (err) {
        console.error("Error fetching events for survey:", err);
        // Fallback: If DB fails, provide dummy events so the page still loads
        const dummyEvents = [
            { eventname: 'Leadership Summit' },
            { eventname: 'Watercolor Workshop' },
            { eventname: 'Code Camp' }
        ];
        res.render("takeSurvey", { events: dummyEvents });
    }
});

// 2. Process the Submission
app.post("/survey/submit", async (req, res) => {
    // ... (This part stays mostly the same, just logging/saving the data)
    const { eventName, satisfaction, comments } = req.body;
    console.log(`New Survey for ${eventName}: Score ${satisfaction}`);
    res.redirect('/thankyou');
});

// 3. Process Survey Submission
app.post("/surveys/submit", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { firstName, lastName, email, eventName, satisfaction, comments } = req.body;

    try {
        // Log the data for now (insert to DB here if you have the table)
        console.log("Survey received for:", eventName);
        console.log("Rating:", satisfaction);
        
        res.redirect('/thankyou');

    } catch (err) {
        console.error("Survey submit error:", err);
        res.send("Error submitting survey.");
    }
});

// --- OTHER DATA ROUTES ---

app.get("/milestones", (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    res.render("milestones");
});

// app.get("/donations", (req, res) => {
//     if (!req.session.username) return res.redirect('/login');
//     res.render("donations");
// });

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

app.get("/admin/users", (req, res) => {
    if (req.session.level !== 'M') return res.redirect('/');
    res.render("userMaintenance");
});

app.get("/teapot", (req, res) => {
    res.status(418).send("418: I'm a little Teapot (Short and stout)");
});

app.listen(port, () => console.log(`Server running on port ${port}`));