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
            role: req.session.level === 'M' ? 'Manager' : 'User',
            isParent: req.session.isParent
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
        req.session.isParent = newUser.parentflag;

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

    try {
        // 1. Basic Validation
        if (!username || !password) {
            return res.render('login', { error: 'Username and password are required.' });
        }

        // 2. Fetch user from Database
        // (We use lowercase to ensure case-insensitive matching)
        const user = await knex('users').where({ username: username.toLowerCase() }).first();

        // 3. Check if User Exists & Password Matches
        // (Note: In a real app, you should compare hashed passwords, not plain text)
        if (!user || user.password !== password) {
            return res.render('login', { error: 'Invalid username or password.' });
        }

        // 4. Set Session Variables
        req.session.username = user.username;
        req.session.firstName = user.firstname;
        req.session.level = user.level;     // 'M' or 'U'
        req.session.isParent = user.parentflag; // True/False

        // 5. Save Session & Redirect
        req.session.save(err => {
            if (err) console.error("Session save error:", err);
            
            // Redirect Manager to Dashboard, everyone else to Home
            if (req.session.level === 'M') {
                res.redirect('/admin/dashboard');
            } else {
                res.redirect('/');
            }
        });

    } catch (err) {
        console.error('Login error:', err);
        return res.render('login', { error: 'An error occurred while logging in. Please try again.' });
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

app.get("/admin/dashboard", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    if (req.session.level !== 'M') return res.redirect('/');

    try {
        // 1. Count Total Participants
        const partResult = await knex('participants').count('participantid as count').first();
        const participantCount = partResult.count;

        // 2. Count Active (Upcoming) Events
        const eventResult = await knex('event_schedule')
            .where('eventdatetimestart', '>=', new Date())
            .count('scheduleid as count')
            .first();
        const eventCount = eventResult.count;

        // 3. Count Survey Responses
        const surveyResult = await knex('surveys').count('surveyid as count').first();
        const surveyCount = surveyResult.count;

        // 4. Sum Total Donations
        const donationResult = await knex('donations').sum('donationamount as total').first();
        const donationTotal = donationResult.total || 0; // Handle null if no donations

        // Render the dashboard with real data
        res.render("admin/dashboard", { 
            stats: {
                participants: participantCount,
                events: eventCount,
                surveys: surveyCount,
                donations: donationTotal
            }
        });

    } catch (err) {
        console.error("Error loading dashboard stats:", err);
        // Fallback to 0 if DB fails so page still loads
        res.render("admin/dashboard", { 
            stats: { participants: 0, events: 0, surveys: 0, donations: 0 } 
        });
    }
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
        res.redirect('/');
    }
});

// 2. Process Account Update
app.post("/account", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { 
        username, firstname, lastname, userdob, email, phone, 
        city, state, zip, password, 
        schoolOrEmployer, fieldOfInterest 
    } = req.body;

    try {
        // Get current user
        const currentUser = await knex('users').where({ username: req.session.username }).first();
        
        if (!currentUser) return res.redirect('/login');

        // --- 1. Update USERS Table ---
        const userUpdateData = {
            username: username.toLowerCase(),
            firstname,
            lastname,
            dob: userdob,
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

        // --- 2. Update PARTICIPANTS Table (If they have one) ---
        // Only update participant details if they are NOT a parent (Students usually update their own info)
        // OR if you want parents to update their own "Participant" record if they have one.
        // Safe bet: Update it if it exists.
        const hasParticipantRecord = await knex('participants').where({ username: currentUser.username }).first();
        
        if (hasParticipantRecord) {
            await knex('participants')
                .where({ username: currentUser.username }) // This assumes username didn't change yet, or cascade handles it
                .update({
                    participantschooloremployer: schoolOrEmployer,
                    participantfieldofinterest: fieldOfInterest,
                    // Also update basic contact info in participant table to keep in sync
                    participantfirstname: firstname,
                    participantlastname: lastname,
                    participantemail: email.toLowerCase(),
                    participantphone: phone
                });
        }

        // Update Session with new info
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

// --- PARTICIPANTS ---

// 1. LIST PARTICIPANTS (With Search)
app.get("/participants", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    // 1. Get Search Params
    const { firstName, lastName, username } = req.query;

    try {
        let query = knex('participants')
            .select(
                'participantid',
                'participantfirstname',
                'participantlastname',
                'participantemail',
                'participantschooloremployer',
                'participantfieldofinterest',
                'username'
            );

        // 2. Apply Search Filters
        if (firstName) {
            query = query.where('participantfirstname', 'ilike', `%${firstName}%`);
        }
        if (lastName) {
            query = query.where('participantlastname', 'ilike', `%${lastName}%`);
        }
        if (username) {
            query = query.where('username', 'ilike', `%${username}%`);
        }

        // 3. Apply Sorting
        // If Parent: Show their linked kids (matching username) FIRST (0), everyone else SECOND (1)
        if (req.session.isParent) {
            query = query.orderByRaw(`CASE WHEN username = ? THEN 0 ELSE 1 END`, [req.session.username]);
        }
        query = query.orderBy('participantid', 'desc'); // Secondary sort

        // 4. Execute Query
        const participants = await query;

        // 5. Fetch Milestones
        const milestoneCounts = await knex('milestones')
            .select('participantid')
            .count('milestoneid as count')
            .groupBy('participantid');

        // 6. Merge counts
        participants.forEach(p => {
            const match = milestoneCounts.find(m => m.participantid == p.participantid);
            p.milestone_count = match ? match.count : 0;
        });

        // 7. Render with Search Terms
        res.render("participants", { 
            participants,
            searchFirstName: firstName || '',
            searchLastName: lastName || '',
            searchUsername: username || ''
        });

    } catch (err) {
        console.error("Error fetching participants:", err);
        res.render("participants", { 
            participants: [],
            searchFirstName: '',
            searchLastName: '',
            searchUsername: ''
        });
    }
});

// 2. GET ADD FORM
app.get("/participants/add", (req, res) => {
    if (!req.session.username || (req.session.level !== 'M' && !req.session.isParent)) {
        return res.redirect('/participants');
    }
    res.render("addParticipant");
});

// 3. POST ADD FORM
app.post("/participants/add", async (req, res) => {
    if (!req.session.username || (req.session.level !== 'M' && !req.session.isParent)) {
        return res.redirect('/');
    }

    const { firstName, lastName, email, phone, dob, zip, employer, interest, username } = req.body;
    
    let targetUsername = req.body.username;
    if (req.session.isParent) {
        targetUsername = req.session.username;
    }

    try {
        if (targetUsername && targetUsername.trim() !== "") {
            const userExists = await knex('users').where({ username: targetUsername.toLowerCase() }).first();
            if (!userExists) {
                return res.render("addParticipant", { 
                    error: "Error: That username does not exist.",
                    firstName, lastName, email, phone, dob, zip, employer, interest, username: targetUsername
                });
            }
        }

        await knex('participants').insert({
            participantfirstname: firstName,
            participantlastname: lastName,
            participantemail: email,
            participantphone: phone,
            participantdob: dob || null, 
            participantzip: zip,
            participantschooloremployer: employer,
            participantfieldofinterest: interest,
            username: targetUsername || null
        });

        res.redirect('/participants');

    } catch (err) {
        console.error("Error adding participant:", err);
        res.render("addParticipant", { 
            error: "Database error: " + err.message,
            firstName, lastName, email, phone, dob, zip, employer, interest, username: targetUsername
        });
    }
});

// 4. GET EDIT FORM (Smart Permissions + Autofill Data)
app.get("/participants/edit/:id", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        const participant = await knex('participants').where({ participantid: req.params.id }).first();
        
        if (!participant) return res.redirect('/participants');

        // PERMISSION CHECK:
        // You can edit if: You are a Manager OR You are the Parent linked to this kid
        const isOwner = participant.username === req.session.username;
        const isManager = req.session.level === 'M';

        if (!isManager && !isOwner) {
            return res.redirect('/participants');
        }
        
        // Render the NEW edit template
        res.render("editParticipant", { participant }); 

    } catch (err) {
        console.error("Error finding participant:", err);
        res.redirect('/participants');
    }
});

// 5. POST EDIT FORM (Update All Fields)
app.post("/participants/edit/:id", async (req, res) => {
    if (!req.session.username) return res.redirect('/');

    // Gather all fields
    const { firstName, lastName, email, phone, dob, zip, employer, interest, username } = req.body;

    try {
        // Fetch first to check permissions
        const participant = await knex('participants').where({ participantid: req.params.id }).first();
        if (!participant) return res.redirect('/participants');

        const isOwner = participant.username === req.session.username;
        const isManager = req.session.level === 'M';

        if (!isManager && !isOwner) {
            return res.redirect('/participants');
        }

        // Prepare Update Object
        const updateData = {
            participantfirstname: firstName,
            participantlastname: lastName,
            participantemail: email,
            participantphone: phone,
            participantdob: dob || null,
            participantzip: zip,
            participantschooloremployer: employer,
            participantfieldofinterest: interest
        };

        // Only allow changing the linked username if you are a Manager
        // (Parents shouldn't accidentally unlink their kids)
        if (isManager) {
            updateData.username = username || null;
        }

        await knex('participants')
            .where({ participantid: req.params.id })
            .update(updateData);
        
        res.redirect('/participants');

    } catch (err) {
        console.error("Error updating participant:", err);
        res.send("Error updating participant: " + err.message);
    }
});

// 6. DELETE PARTICIPANT (Manager Only - Safety First)
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

// 1. VIEW EVENTS (Fixed: Now selects eventid for the Edit button)
app.get("/events", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    // GET SEARCH PARAMS
    const { searchEvent, searchLocation } = req.query;

    try {
        // A. GET ALL EVENTS (Base Query)
        let query = knex('event_schedule')
            .join('events', 'event_schedule.eventid', '=', 'events.eventid')
            .leftJoin('registrations', 'event_schedule.scheduleid', 'registrations.scheduleid')
            .select(
                'event_schedule.scheduleid',
                'events.eventid',
                'events.eventname',
                'events.eventtype',
                'events.eventdescription',
                'event_schedule.eventdatetimestart',
                'event_schedule.eventlocation'
            )
            .count('registrations.registrationid as reg_count')
            .groupBy(
                'event_schedule.scheduleid', 
                'events.eventid',
                'events.eventname', 
                'events.eventtype', 
                'events.eventdescription', 
                'event_schedule.eventdatetimestart', 
                'event_schedule.eventlocation'
            );

        // APPLY FILTERS
        if (searchEvent) {
            query = query.where('events.eventname', 'ilike', `%${searchEvent}%`);
        }
        if (searchLocation) {
            query = query.where('event_schedule.eventlocation', 'ilike', `%${searchLocation}%`);
        }

        // EXECUTE QUERY
        const allEvents = await query.orderBy('event_schedule.eventdatetimestart', 'asc');

        const now = new Date();
        const upcoming = allEvents.filter(e => new Date(e.eventdatetimestart) >= now);
        const past = allEvents.filter(e => new Date(e.eventdatetimestart) < now).reverse();

        // B. GET LINKED PARTICIPANTS
        const myParticipants = await knex('participants')
            .where({ username: req.session.username })
            .select('participantid', 'participantfirstname', 'participantlastname');

        // C. GET MY REGISTRATIONS
        const rawRegistrations = await knex('registrations')
            .join('event_schedule', 'registrations.scheduleid', '=', 'event_schedule.scheduleid')
            .join('events', 'event_schedule.eventid', '=', 'events.eventid')
            .join('participants', 'registrations.participantid', '=', 'participants.participantid')
            .whereIn('participants.username', [req.session.username])
            .select(
                'registrations.registrationid',
                'event_schedule.scheduleid',
                'events.eventname',
                'event_schedule.eventdatetimestart',
                'event_schedule.eventlocation',
                'participants.participantfirstname',
                'participants.participantid'
            )
            .orderBy('event_schedule.eventdatetimestart', 'asc');

        // Logic: Create Lookup Set
        const registeredSet = new Set(
            rawRegistrations.map(r => `${r.scheduleid}-${r.participantid}`)
        );

        // Logic: Group My Events
        const groupedRegistrations = {};
        rawRegistrations.forEach(row => {
            if (!groupedRegistrations[row.scheduleid]) {
                groupedRegistrations[row.scheduleid] = {
                    eventname: row.eventname,
                    eventdatetimestart: row.eventdatetimestart,
                    eventlocation: row.eventlocation,
                    attendees: [] 
                };
            }
            groupedRegistrations[row.scheduleid].attendees.push({
                registrationid: row.registrationid,
                name: row.participantfirstname,
                id: row.participantid
            });
        });
        const myRegistrations = Object.values(groupedRegistrations);

        res.render("events", { 
            upcoming, 
            past, 
            myParticipants, 
            myRegistrations, 
            registeredSet,
            // PASS SEARCH TERMS BACK
            searchEvent: searchEvent || '',
            searchLocation: searchLocation || ''
        });

    } catch (err) {
        console.error("Error fetching events:", err);
        res.render("events", { upcoming: [], past: [], myParticipants: [], myRegistrations: [], registeredSet: new Set(), searchEvent: '', searchLocation: '' }); 
    }
});

// 2. REGISTER / SYNC (Handles Checkboxes & Single Buttons)
app.post("/events/register", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { scheduleId, participantId } = req.body;

    try {
        if (req.session.isParent) {
            // --- PARENT SYNC MODE (Add Checked, Remove Unchecked) ---
            
            // 1. Get List of IDs wanted (handle single value vs array vs undefined)
            const requestedIds = new Set(
                (Array.isArray(participantId) ? participantId : [participantId])
                .filter(Boolean) // remove null/undefined
                .map(id => parseInt(id))
            );

            // 2. Get all kids belonging to this parent (Security Check)
            const myKids = await knex('participants')
                .where({ username: req.session.username })
                .select('participantid');

            // 3. Loop through EACH kid and Sync status
            for (const kid of myKids) {
                if (requestedIds.has(kid.participantid)) {
                    // WANT: Register (Insert if not exists)
                    await knex('registrations').insert({
                        scheduleid: scheduleId,
                        participantid: kid.participantid
                    }).onConflict(['participantid', 'scheduleid']).ignore();
                } else {
                    // DON'T WANT: Unregister (Delete if exists)
                    await knex('registrations')
                        .where({ scheduleid: scheduleId, participantid: kid.participantid })
                        .del();
                }
            }

        } else {
            // --- STUDENT MODE (Single Add) ---
            if (participantId) {
                await knex('registrations').insert({
                    scheduleid: scheduleId,
                    participantid: participantId
                }).onConflict(['participantid', 'scheduleid']).ignore();
            }
        }

        res.redirect('/events');

    } catch (err) {
        console.error("Registration error:", err);
        res.redirect('/events');
    }
});

// 3. UNREGISTER (For Student 'Leave' Button or specific cancel)
app.post("/events/unregister", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    
    const { registrationId, scheduleId, participantId } = req.body;

    try {
        if (registrationId) {
            // Delete by Registration ID (from My Events list)
            await knex('registrations').where({ registrationid: registrationId }).del();
        } else if (scheduleId && participantId) {
            // Delete by Event+User (from Student Toggle Button)
            await knex('registrations')
                .where({ scheduleid: scheduleId, participantid: participantId })
                .del();
        }
        
        res.redirect('/events');
    } catch (err) {
        console.error("Unregister error:", err);
        res.redirect('/events');
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

// 6. GET EDIT EVENT FORM (Manager Only)
app.get("/events/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/events');

    try {
        // Fetch the event to pre-fill the form
        // FIX: Join with event_schedule so we actually get the date!
        const event = await knex('events')
            .join('event_schedule', 'events.eventid', '=', 'event_schedule.eventid')
            .where({ 'events.eventid': req.params.id })
            .select(
                'events.*',
                'event_schedule.eventdatetimestart as eventdate', // Alias to match view expectation
                'event_schedule.eventlocation'
            )
            .first();
        
        if (!event) return res.redirect('/events');

        res.render("editEvent", { event });
    } catch (err) {
        console.error("Error fetching event to edit:", err);
        res.redirect('/events');
    }
});

// 7. POST EDIT EVENT (Manager Only)
app.post("/events/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { eventName, eventType, eventDescription, eventdate, eventLocation } = req.body;

    try {
        // 1. Update the generic event details
        await knex('events')
            .where({ eventid: req.params.id })
            .update({
                eventname: eventName,
                eventtype: eventType,
                eventdescription: eventDescription
            });

        // 2. Update the specific schedule details
        await knex('event_schedule')
            .where({ eventid: req.params.id })
            .update({
                eventdatetimestart: eventdate,
                eventdatetimeend: eventdate, // Sync end time for now
                eventlocation: eventLocation
            });

        res.redirect('/events');
    } catch (err) {
        console.error("Error updating event:", err);
        res.send("Error updating event.");
    }
});

// 8. DELETE EVENT (Manager Only)
app.post("/events/delete/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // Deleting the event will cascade delete the registrations automatically
        await knex('events').where({ eventid: req.params.id }).del();
        res.redirect('/events');
    } catch (err) {
        console.error("Error deleting event:", err);
        res.redirect('/events');
    }
});

// --- SURVEYS ---

app.get("/surveys", (req, res) => {
    res.redirect("/survey"); 
});

// 1. SHOW SURVEY FORM (Matches your new ejs)
app.get("/survey", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        // A. Get "Who" (The logged-in user's linked participants)
        const myParticipants = await knex('participants')
            .where({ username: req.session.username })
            .select('participantid', 'participantfirstname', 'participantlastname');

        // B. Get "What" (ALL past events)
        // Linking event_schedule -> events to get the name
        const pastEvents = await knex('event_schedule')
            .join('events', 'event_schedule.eventid', '=', 'events.eventid')
            .where('event_schedule.eventdatetimestart', '<', new Date()) 
            .select(
                'event_schedule.scheduleid', 
                'events.eventname', 
                'event_schedule.eventdatetimestart'
            )
            .orderBy('event_schedule.eventdatetimestart', 'desc');

        res.render("surveys", { myParticipants, pastEvents });

    } catch (err) {
        console.error("Error fetching survey data:", err);
        res.render("surveys", { myParticipants: [], pastEvents: [] });
    }
});

// 2. SUBMIT SURVEY (Fixed to use scheduleid/participantid)
app.post("/survey/submit", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    // The form sends these IDs directly now
    const { participantId, scheduleId, satisfaction, usefulness, recommendation, comments } = req.body;

    try {
        // 1. Check if a registration ALREADY exists for this kid + event
        // We search the 'registrations' table (where registrationid DOES exist)
        let registration = await knex('registrations')
            .where({ scheduleid: scheduleId, participantid: participantId })
            .first();

        // 2. If they aren't registered yet, AUTO-REGISTER them (Walk-in logic)
        if (!registration) {
            const [newReg] = await knex('registrations').insert({
                scheduleid: scheduleId,
                participantid: participantId,
                registrationstatus: 'Attended', // Mark them as attended
                registrationattendedflag: true
            }).returning('registrationid');
            
            // Use the new ID
            const newId = newReg.registrationid || newReg;
            registration = { registrationid: newId };
        }

        // 3. Calculate NPS Bucket (1-5 Scale)
        let npsBucket = 'Passive';
        const recScore = parseInt(recommendation);
        if (recScore >= 5) npsBucket = 'Promoter';
        if (recScore <= 3) npsBucket = 'Detractor';

        // 4. Insert Survey (Using SCHEDULEID and PARTICIPANTID, NOT registrationid)
        await knex('surveys').insert({
            scheduleid: scheduleId,       // ✅ Correct Column
            participantid: participantId, // ✅ Correct Column
            surveysatisfactionscore: satisfaction,
            surveyusefulnessscore: usefulness,
            surveyrecommendationscore: recommendation,
            surveynpsbucket: npsBucket,
            surveycomments: comments,
            surveysubmissiondate: new Date()
        });
        
    res.render('thankyou', { type: 'survey' });

    } catch (err) {
        console.error("Survey submit error:", err);
        res.redirect('/survey');
    }
});

// 3. ADMIN: VIEW RESPONSES (Fixed Joins)
// ==========================================
// 1. UPDATE: EVENTS ROUTE (Search Added)
// ==========================================
app.get("/events", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    // GET SEARCH PARAMS
    const { searchEvent, searchLocation } = req.query;

    try {
        // A. GET ALL EVENTS (Base Query)
        let query = knex('event_schedule')
            .join('events', 'event_schedule.eventid', '=', 'events.eventid')
            .leftJoin('registrations', 'event_schedule.scheduleid', 'registrations.scheduleid')
            .select(
                'event_schedule.scheduleid',
                'events.eventid',
                'events.eventname',
                'events.eventtype',
                'events.eventdescription',
                'event_schedule.eventdatetimestart',
                'event_schedule.eventlocation'
            )
            .count('registrations.registrationid as reg_count')
            .groupBy(
                'event_schedule.scheduleid', 
                'events.eventid',
                'events.eventname', 
                'events.eventtype', 
                'events.eventdescription', 
                'event_schedule.eventdatetimestart', 
                'event_schedule.eventlocation'
            );

        // APPLY FILTERS
        if (searchEvent) {
            query = query.where('events.eventname', 'ilike', `%${searchEvent}%`);
        }
        if (searchLocation) {
            query = query.where('event_schedule.eventlocation', 'ilike', `%${searchLocation}%`);
        }

        // EXECUTE QUERY
        const allEvents = await query.orderBy('event_schedule.eventdatetimestart', 'asc');

        const now = new Date();
        const upcoming = allEvents.filter(e => new Date(e.eventdatetimestart) >= now);
        const past = allEvents.filter(e => new Date(e.eventdatetimestart) < now).reverse();

        // B. GET LINKED PARTICIPANTS
        const myParticipants = await knex('participants')
            .where({ username: req.session.username })
            .select('participantid', 'participantfirstname', 'participantlastname');

        // C. GET MY REGISTRATIONS
        const rawRegistrations = await knex('registrations')
            .join('event_schedule', 'registrations.scheduleid', '=', 'event_schedule.scheduleid')
            .join('events', 'event_schedule.eventid', '=', 'events.eventid')
            .join('participants', 'registrations.participantid', '=', 'participants.participantid')
            .whereIn('participants.username', [req.session.username])
            .select(
                'registrations.registrationid',
                'event_schedule.scheduleid',
                'events.eventname',
                'event_schedule.eventdatetimestart',
                'event_schedule.eventlocation',
                'participants.participantfirstname',
                'participants.participantid'
            )
            .orderBy('event_schedule.eventdatetimestart', 'asc');

        // Logic: Create Lookup Set
        const registeredSet = new Set(
            rawRegistrations.map(r => `${r.scheduleid}-${r.participantid}`)
        );

        // Logic: Group My Events
        const groupedRegistrations = {};
        rawRegistrations.forEach(row => {
            if (!groupedRegistrations[row.scheduleid]) {
                groupedRegistrations[row.scheduleid] = {
                    eventname: row.eventname,
                    eventdatetimestart: row.eventdatetimestart,
                    eventlocation: row.eventlocation,
                    attendees: [] 
                };
            }
            groupedRegistrations[row.scheduleid].attendees.push({
                registrationid: row.registrationid,
                name: row.participantfirstname,
                id: row.participantid
            });
        });
        const myRegistrations = Object.values(groupedRegistrations);

        res.render("events", { 
            upcoming, 
            past, 
            myParticipants, 
            myRegistrations, 
            registeredSet,
            // PASS SEARCH TERMS BACK
            searchEvent: searchEvent || '',
            searchLocation: searchLocation || ''
        });

    } catch (err) {
        console.error("Error fetching events:", err);
        res.render("events", { upcoming: [], past: [], myParticipants: [], myRegistrations: [], registeredSet: new Set(), searchEvent: '', searchLocation: '' }); 
    }
});

// ==========================================
// 2. UPDATE: DONATIONS ROUTE (Search Added)
// ==========================================
app.get("/admin/donations", async (req, res) => {
    if (!req.session.username) {
        return res.redirect('/');
    }

    const { searchDonor } = req.query;

    try {
        let query = knex('donations')
            .join('participants', 'donations.participantid', '=', 'participants.participantid')
            .select(
                'donations.donationid',
                'donations.donationamount',
                'donations.donationdate',
                'donations.donationnotes',
                'participants.participantfirstname',
                'participants.participantlastname',
                'participants.participantemail'
            );

        if (searchDonor) {
            query = query.where(builder => {
                builder.where('participants.participantfirstname', 'ilike', `%${searchDonor}%`)
                       .orWhere('participants.participantlastname', 'ilike', `%${searchDonor}%`)
                       .orWhere('participants.participantemail', 'ilike', `%${searchDonor}%`);
            });
        }

        const donations = await query.orderByRaw('donations.donationdate DESC NULLS LAST');

        res.render("admin/donationHistory", { 
            donations,
            searchDonor: searchDonor || ''
        });
    } catch (err) {
        console.error("Error fetching donation history:", err);
        res.render("admin/donationHistory", { donations: [], searchDonor: '' });
    }
});

// ==========================================
// 3. UPDATE: SURVEYS ROUTE (Search Added)
// ==========================================
app.get("/admin/survey-data", async (req, res) => {
    if (!req.session.username) {
        return res.redirect('/login');
    }

    const { searchSurvey } = req.query;

    try {
        let query = knex('surveys')
            .join('event_schedule', 'surveys.scheduleid', '=', 'event_schedule.scheduleid')
            .join('events', 'event_schedule.eventid', '=', 'events.eventid')
            .join('participants', 'surveys.participantid', '=', 'participants.participantid')
            .select(
                'surveys.surveyid',
                'events.eventname as event_name',
                'event_schedule.eventdatetimestart',
                'participants.participantfirstname',
                'participants.participantlastname',
                'surveys.surveysatisfactionscore as satisfaction_score',
                'surveys.surveyusefulnessscore as usefulness_score',
                'surveys.surveynpsbucket',
                'surveys.surveycomments as comments'
            );

        if (searchSurvey) {
            query = query.where('events.eventname', 'ilike', `%${searchSurvey}%`)
                         .orWhere('participants.participantfirstname', 'ilike', `%${searchSurvey}%`)
                         .orWhere('participants.participantlastname', 'ilike', `%${searchSurvey}%`);
        }

        const responses = await query.orderBy('surveys.surveyid', 'desc');

        res.render("admin/surveyResponses", { 
            responses,
            searchSurvey: searchSurvey || ''
        });

    } catch (err) {
        console.error("Error fetching responses:", err);
        res.render("admin/surveyResponses", { responses: [], searchSurvey: '' });
    }
});

// 4. DELETE SURVEY (Manager Only)
app.post("/survey/delete/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/admin/survey-data');

    try {
        await knex('surveys').where({ surveyid: req.params.id }).del();
        res.redirect('/admin/survey-data');
    } catch (err) {
        console.error("Error deleting survey:", err);
        res.redirect('/admin/survey-data');
    }
});

// 5. GET EDIT SURVEY FORM (Manager Only)
app.get("/survey/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/admin/survey-data');

    try {
        const survey = await knex('surveys')
            .join('event_schedule', 'surveys.scheduleid', '=', 'event_schedule.scheduleid')
            .join('events', 'event_schedule.eventid', '=', 'events.eventid')
            .join('participants', 'surveys.participantid', '=', 'participants.participantid')
            .where({ surveyid: req.params.id })
            .select(
                'surveys.*',
                'events.eventname',
                'participants.participantfirstname',
                'participants.participantlastname'
            )
            .first();

        if (!survey) return res.redirect('/admin/survey-data');

        res.render("editSurvey", { survey });

    } catch (err) {
        console.error("Error fetching survey to edit:", err);
        res.redirect('/admin/survey-data');
    }
});

// 6. POST EDIT SURVEY (Manager Only)
app.post("/survey/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { satisfaction, usefulness, recommendation, comments } = req.body;

    try {
        // Recalculate NPS
        let npsBucket = 'Passive';
        const recScore = parseInt(recommendation);
        if (recScore >= 5) npsBucket = 'Promoter'; 
        if (recScore <= 3) npsBucket = 'Detractor';

        await knex('surveys')
            .where({ surveyid: req.params.id })
            .update({
                surveysatisfactionscore: satisfaction,
                surveyusefulnessscore: usefulness,
                surveyrecommendationscore: recommendation,
                surveynpsbucket: npsBucket,
                surveycomments: comments
            });

        res.redirect('/admin/survey-data');
    } catch (err) {
        console.error("Error updating survey:", err);
        res.send("Error updating survey.");
    }
});

// --- MILESTONES ---

// 1. LIST ALL MILESTONES (With Search) - Managers Only (Global View)
app.get("/milestones", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { firstName, lastName } = req.query;

    try {
        let query = knex('participants').orderBy('participantlastname', 'asc');


        if (firstName) query = query.where('participantfirstname', 'ilike', `%${firstName}%`);
        if (lastName) query = query.where('participantlastname', 'ilike', `%${lastName}%`);

        const participants = await query;
        
        const milestones = await knex('milestones')
            .select('milestoneid', 'participantid', 'milestonetitle', 'milestonedate', 'milestonenotes')
            .orderBy('milestonedate', 'desc');

        const safeParticipants = Array.isArray(participants) ? participants : [];

        const participantsWithMilestones = safeParticipants.map(p => {
            return {
                ...p,
                milestones: milestones.filter(m => m.participantid == p.participantid) 
            };
        });

        res.render("milestones", { 
            participants: participantsWithMilestones,
            searchFirstName: firstName || '',
            searchLastName: lastName || ''
        });

    } catch (err) {
        console.error("Error in /milestones:", err);
        res.render("milestones", { participants: [], searchFirstName: '', searchLastName: '' });
    }
});



// 2. VIEW DETAILS (Specific Participant) - UPDATED: Allows Manager OR Owner
app.get("/milestones/view/:id", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        const participant = await knex('participants').where({ participantid: req.params.id }).first();
        if (!participant) return res.redirect('/participants');

        // PERMISSION CHECK: Manager OR Owner
        const isOwner = participant.username === req.session.username;
        const isManager = req.session.level === 'M';

        if (!isManager && !isOwner) {
            return res.redirect('/participants');
        }

        const milestones = await knex('milestones')
            .where({ participantid: req.params.id })
            .orderBy('milestonedate', 'desc');

        res.render("milestoneDetails", { participant, milestones });
    } catch (err) {
        console.error("Error fetching detail:", err);
        res.redirect('/participants');
    }
});

// 3. ADD MILESTONE (GET) - UPDATED: Allows Manager OR Owner
app.get("/milestones/add/:id", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    
    try {
        const participant = await knex('participants').where({ participantid: req.params.id }).first();
        if (!participant) return res.redirect('/participants');

        const isOwner = participant.username === req.session.username;
        const isManager = req.session.level === 'M';

        if (!isManager && !isOwner) return res.redirect('/participants');

        res.render("addMilestone", { participant });
    } catch (err) {
        console.error("Error getting add form:", err);
        res.redirect('/milestones');
    }
});

// 4. ADD MILESTONE (POST) - UPDATED: Allows Manager OR Owner
app.post("/milestones/add/:id", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { milestoneTitle, milestoneDate, notes } = req.body;

    try {
        // Double check permission on POST
        const participant = await knex('participants').where({ participantid: req.params.id }).first();
        const isOwner = participant.username === req.session.username;
        const isManager = req.session.level === 'M';

        if (!isManager && !isOwner) return res.redirect('/participants');

        await knex('milestones').insert({
            participantid: req.params.id,
            milestonetitle: milestoneTitle,
            milestonedate: milestoneDate,
            milestonenotes: notes
        });
        
        // Redirect back to the specific view for this participant
        res.redirect(`/milestones/view/${req.params.id}`);
    } catch (err) {
        console.error("Error creating milestone:", err);
        res.send("Error adding milestone.");
    }
});

// 5. EDIT MILESTONE (GET) - UPDATED: Allows Manager OR Owner
app.get("/milestones/edit/:id", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        const milestone = await knex('milestones').where({ milestoneid: req.params.id }).first();
        if (!milestone) return res.redirect('/milestones');

        const participant = await knex('participants').where({ participantid: milestone.participantid }).first();
        
        const isOwner = participant.username === req.session.username;
        const isManager = req.session.level === 'M';

        if (!isManager && !isOwner) return res.redirect('/participants');
        
        res.render("editMilestone", { milestone, participant });
    } catch (err) {
        console.error("Error fetching milestone to edit:", err);
        res.redirect('/milestones');
    }
});

// 6. EDIT MILESTONE (POST) - UPDATED: Allows Manager OR Owner
app.post("/milestones/edit/:id", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { milestoneTitle, milestoneDate, notes } = req.body;

    try {
        const milestone = await knex('milestones').where({ milestoneid: req.params.id }).first();
        const participant = await knex('participants').where({ participantid: milestone.participantid }).first();
        
        const isOwner = participant.username === req.session.username;
        const isManager = req.session.level === 'M';

        if (!isManager && !isOwner) return res.redirect('/participants');

        await knex('milestones')
            .where({ milestoneid: req.params.id })
            .update({
                milestonetitle: milestoneTitle,
                milestonedate: milestoneDate,
                milestonenotes: notes
            });
        
        res.redirect(`/milestones/view/${participant.participantid}`);
    } catch (err) {
        console.error("Error updating milestone:", err);
        res.send("Error updating milestone.");
    }
});

// 7. DELETE MILESTONE - UPDATED: Allows Manager OR Owner
app.post("/milestones/delete/:id", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    
    try {
        const milestone = await knex('milestones').where({ milestoneid: req.params.id }).first();
        if (milestone) {
            const participant = await knex('participants').where({ participantid: milestone.participantid }).first();
            
            const isOwner = participant.username === req.session.username;
            const isManager = req.session.level === 'M';

            if (isManager || isOwner) {
                await knex('milestones').where({ milestoneid: req.params.id }).del();
                return res.redirect(`/milestones/view/${participant.participantid}`);
            }
        }
        res.redirect('/participants');
    } catch(err) {
        console.error("Delete error", err);
        res.redirect('/participants');
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

    res.render('thankyou', { type: 'donation' });

    } catch (err) {
        console.error('Donation processing error:', err);
        res.render('donations', { 
            error: 'Error processing donation. Please check your data.',
            firstName, lastName, email, amount
        });
    }
});

// --- ADMIN DONATION ROUTES ---

// 1. LIST DONATIONS
app.get("/admin/donations", async (req, res) => {
    if (!req.session.username) {
        return res.redirect('/');
    }

    const { searchDonor } = req.query;

    try {
        let query = knex('donations')
            .join('participants', 'donations.participantid', '=', 'participants.participantid')
            .select(
                'donations.donationid',
                'donations.donationamount',
                'donations.donationdate',
                'donations.donationnotes',
                'participants.participantfirstname',
                'participants.participantlastname',
                'participants.participantemail'
            );

        if (searchDonor) {
            query = query.where(builder => {
                builder.where('participants.participantfirstname', 'ilike', `%${searchDonor}%`)
                       .orWhere('participants.participantlastname', 'ilike', `%${searchDonor}%`)
                       .orWhere('participants.participantemail', 'ilike', `%${searchDonor}%`);
            });
        }

        const donations = await query.orderByRaw('donations.donationdate DESC NULLS LAST');

        res.render("admin/donationHistory", { 
            donations,
            searchDonor: searchDonor || ''
        });
    } catch (err) {
        console.error("Error fetching donation history:", err);
        res.render("admin/donationHistory", { donations: [], searchDonor: '' });
    }
});

// 2. SHOW ADD DONATION FORM (With Search)
app.get("/admin/donations/add", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    // Get query params (Search terms + Selected User ID)
    const { firstName, lastName, username, selectedId } = req.query;
    
    let participants = [];
    let selectedParticipant = null;

    try {
        // A. If a user was selected, fetch their details
        if (selectedId) {
            selectedParticipant = await knex('participants')
                .where({ participantid: selectedId })
                .first();
        }

        // B. If search terms exist, run the search
        if (firstName || lastName || username) {
            let query = knex('participants')
                .select('participantid', 'participantfirstname', 'participantlastname', 'participantemail', 'username')
                .orderBy('participantlastname', 'asc')
                .limit(50); // Limit results to keep page light

            if (firstName) query = query.where('participantfirstname', 'ilike', `%${firstName}%`);
            if (lastName) query = query.where('participantlastname', 'ilike', `%${lastName}%`);
            if (username) query = query.where('username', 'ilike', `%${username}%`);

            participants = await query;
        }

        res.render("addDonation", { 
            participants, 
            selectedParticipant,
            // Pass terms back to keep form filled
            searchFirstName: firstName || '',
            searchLastName: lastName || '',
            searchUsername: username || ''
        });
    } catch (err) {
        console.error("Error loading add donation form:", err);
        res.redirect('/admin/donations');
    }
});

// 3. PROCESS ADD DONATION
app.post("/admin/donations/add", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { participantId, amount, date, notes } = req.body;

    try {
        await knex('donations').insert({
            participantid: participantId,
            donationamount: amount,
            donationdate: date || new Date(),
            donationnotes: notes
        });
        res.redirect('/admin/donations');
    } catch (err) {
        console.error("Error adding donation:", err);
        res.send("Error adding donation.");
    }
});

// 4. SHOW EDIT FORM (With Search & Select Logic)
app.get("/admin/donations/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { firstName, lastName, username, selectedId } = req.query;

    try {
        // A. Fetch the Donation Record
        const donation = await knex('donations').where({ donationid: req.params.id }).first();
        if (!donation) return res.redirect('/admin/donations');

        // B. Determine the "Selected Participant" (The one displayed in the form)
        // Default: The original donor
        let selectedParticipant = await knex('participants')
            .where({ participantid: donation.participantid })
            .first();

        // Override: If user clicked "Select" on a search result, use that ID instead
        if (selectedId) {
            const newSelection = await knex('participants')
                .where({ participantid: selectedId })
                .first();
            if (newSelection) {
                selectedParticipant = newSelection;
            }
        }

        // C. Handle Search Results (for the table)
        let participants = [];
        if (firstName || lastName || username) {
            let query = knex('participants')
                .select('participantid', 'participantfirstname', 'participantlastname', 'participantemail')
                .orderBy('participantlastname', 'asc')
                .limit(50);

            if (firstName) query = query.where('participantfirstname', 'ilike', `%${firstName}%`);
            if (lastName) query = query.where('participantlastname', 'ilike', `%${lastName}%`);
            if (username) query = query.where('username', 'ilike', `%${username}%`);

            participants = await query;
        }

        // D. Render
        res.render("editDonation", { 
            donation, 
            selectedParticipant, // Who is currently linked (or about to be linked)
            participants,        // Search results
            searchFirstName: firstName || '',
            searchLastName: lastName || '',
            searchUsername: username || ''
        });

    } catch (err) {
        console.error("Error loading edit form:", err);
        res.redirect('/admin/donations');
    }
});

// 5. PROCESS EDIT
app.post("/admin/donations/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    // FIX: Added participantId to the destructured object so we can update the donor
    const { participantId, amount, date, notes } = req.body;

    try {
        await knex('donations')
            .where({ donationid: req.params.id })
            .update({
                participantid: participantId, // Update the donor link
                donationamount: amount,
                donationdate: date,
                donationnotes: notes
            });
        res.redirect('/admin/donations');
    } catch (err) {
        console.error("Error updating donation:", err);
        res.send("Error updating donation.");
    }
});

// 6. DELETE DONATION
app.post("/admin/donations/delete/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        await knex('donations').where({ donationid: req.params.id }).del();
        res.redirect('/admin/donations');
    } catch (err) {
        console.error("Error deleting donation:", err);
        res.redirect('/admin/donations');
    }
});

app.get("/thankyou", (req, res) => {
    res.render("thankyou");
});

// =========================================
// 8. ADMIN USER MAINTENANCE
// =========================================

// List Users
// --- USER MAINTENANCE ROUTES (Admin Only) ---

// 1. LIST ALL USERS (With Search)
app.get("/admin/users", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    // 1. Get search params from URL
    const { firstName, lastName, username } = req.query;

    try {
        // 2. Start building the query
        let query = knex('users').select('*').orderBy('username');

        // 3. Apply filters if user typed something
        if (firstName) {
            query = query.where('firstname', 'ilike', `%${firstName}%`);
        }
        if (lastName) {
            query = query.where('lastname', 'ilike', `%${lastName}%`);
        }
        if (username) {
            query = query.where('username', 'ilike', `%${username}%`);
        }

        // 4. Execute query
        const users = await query;

        // 5. Render with search terms passed back
        res.render("admin/userMaintenance", { 
            users,
            searchFirstName: firstName || '',
            searchLastName: lastName || '',
            searchUsername: username || ''
        });

    } catch (err) {
        console.error("Error fetching users:", err);
        res.render("admin/userMaintenance", { 
            users: [],
            searchFirstName: '',
            searchLastName: '',
            searchUsername: ''
        });
    }
});

// --- ADMIN USER MAINTENANCE ROUTES ---

// 1. Show Add User Form
app.get("/admin/users/add", (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');
    res.render("addUser");
});

// 2. Process Add User
app.post("/admin/users/add", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { 
        username, password, firstname, lastname, email, 
        phone, dob, city, state, zip, level, parentflag,
        schoolOrEmployer, fieldOfInterest // New fields
    } = req.body;

    try {
        // 1. Check for duplicates
        const existingUser = await knex('users')
            .where({ username: username.toLowerCase() })
            .orWhere({ email: email.toLowerCase() })
            .first();

        if (existingUser) {
            return res.send("Error: Username or Email already exists.");
        }

        // 2. Perform Database Inserts
        await knex.transaction(async (trx) => {
            
            // A. Insert into USERS table
            await trx('users').insert({
                username: username.toLowerCase(),
                password, 
                firstname,
                lastname,
                email: email.toLowerCase(),
                phone,
                dob: dob || null,
                city,
                state,
                zip,
                level,
                // Parent Logic: Checkbox sends 'on', store as boolean true/false
                parentflag: parentflag === 'on'
            });

            // B. If they are a standard USER and NOT A PARENT, create a Participant record
            if (level === 'U' && parentflag !== 'on') {
                
                // Ensure Zip Code exists (Required for Participant Foreign Key)
                if (zip) {
                    await trx('zip_codes')
                        .insert({ zip, city, state })
                        .onConflict('zip')
                        .ignore();
                }

                // Create Linked Participant Record
                await trx('participants').insert({
                    username: username.toLowerCase(), // The Link
                    participantfirstname: firstname,
                    participantlastname: lastname,
                    participantemail: email.toLowerCase(),
                    participantphone: phone,
                    participantdob: dob || null,
                    participantzip: zip,
                    participantrole: 'Participant',
                    // The new specific fields
                    participantschooloremployer: schoolOrEmployer,
                    participantfieldofinterest: fieldOfInterest
                });
            }
        });
        
        res.redirect('/admin/users');

    } catch (err) {
        console.error("Error adding user:", err);
        res.send("Error adding user. Please check server logs.");
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

app.get("/teapot", (req, res) => {
    // Security Check: Must be logged in
    if (!req.session.username) {
        return res.redirect('/login');
    }
    res.status(418).render("teapot");
});

// =========================================
// 9. SERVER START
// =========================================
app.listen(port, () => console.log(`Server running on port ${port}`));