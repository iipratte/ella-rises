// app.js
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
    ssl: process.env.DB_SSL ? { rejectUnauthorized: false } : false// Required for AWS RDS
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
// Makes 'user' available to all EJS files & fixes the header crash
app.use((req, res, next) => {
    if (req.session && req.session.username) {
        res.locals.user = {
            username: req.session.username,
            // Map DB 'level' ('M') to the Header's expected 'role' ('Manager')
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

// Login Page
app.get("/login", (req, res) => {
    res.render("login");
});

// LOGIN LOGIC (Backdoor + Real DB)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    // --- 🚨 START BACKDOOR (DELETE BEFORE SUBMISSION) 🚨 ---
    
    // 1. MANAGER: Goes to Dashboard
    if (username === 'admin' && password === 'test') {
        console.log("Logging in as Hardcoded Manager...");
        req.session.userId = 888;
        req.session.username = 'Admin';
        req.session.level = 'M'; 
        return res.redirect('/dashboard'); // ✅ Manager goes to Dashboard
    }

    // 2. COMMON USER: Goes to Home Page
    if (username === 'user' && password === 'test') {
        console.log("Logging in as Hardcoded Common User...");
        req.session.userId = 999;
        req.session.username = 'Visitor';
        req.session.level = 'U'; 
        return res.redirect('/'); // ✅ User goes to Home (NOT Dashboard)
    }
    // --- 🚨 END BACKDOOR 🚨 ---

    // REAL DATABASE LOGIC
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

        // --- SPLIT TRAFFIC BASED ON ROLE ---
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

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) console.log(err);
        res.redirect('/');
    });
});

// --- PROTECTED DATA ROUTES ---

// 1. DASHBOARD (STRICTLY MANAGER ONLY)
app.get("/dashboard", (req, res) => {
    // Must be logged in
    if (!req.session.username) return res.redirect('/login');
    
    // Must be a Manager
    if (req.session.level !== 'M') {
        return res.redirect('/'); // Kick common users back to Home
    }
    
    res.render("dashboard");
});

// 2. DATA PAGES (Visible to all logged-in users)
app.get("/participants", (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    res.render("participants");
});

app.get("/events", (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    res.render("events");
});

app.get("/surveys", (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    res.render("surveys");
});

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
                res.render("displayUsers", {users: users});
            })
            .catch((err) => {
                console.error("Database query error:", err.message);
                res.render("displayUsers", {
                    users: [],
                    error_message: `Database error: ${err.message}. Please check if the 'users' table exists.`
                });
            });
});

// --- ADMIN ROUTES (Manager Only) ---

app.get("/admin", (req, res) => {
    if (req.session.level !== 'M') return res.redirect('/');
    res.render("admin");
});

app.get("/admin/users", (req, res) => {
    if (req.session.level !== 'M') return res.redirect('/');
    res.render("userMaintenance");
});

// Rubric Requirement: HTTP 418
app.get("/teapot", (req, res) => {
    res.status(418).send("418: I'm a little Teapot (Short and stout)");
});

// --- 6. START SERVER ---
app.listen(port, () => console.log(`Server running on port ${port}`));