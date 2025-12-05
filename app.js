require('dotenv').config();
const express = require("express");
const session = require("express-session");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

// =========================================
// 1. App Configuration
// =========================================
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// Parse form data
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// =========================================
// 2. Database Connection (Knex) and RDS
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
// 3. Session Setup
// =========================================
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true on HTTPS
}));

// =========================================
// 4. Global User Middleware
// =========================================
app.use((req, res, next) => {
    // Make user data available to EJS templates
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
// 5. Public Routes
// =========================================

// Landing Page
app.get("/", (req, res) => {
    res.render("index");
});

// --- Signup Routes ---
app.get("/signup", (req, res) => {
    res.render("signup");
});

app.post('/signup', async (req, res) => {
    // We get 'userdob' from the HTML form
    const { username, password, firstname, lastname, userdob, email, phone, city, state, zip, isParent, school, interest } = req.body;

    try {
        // 1. Check if user exists
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
                
                // Map the form field userdob to the DB column dob
                dob: userdob, 
                
                email: email.toLowerCase(),
                phone,
                city,
                state,
                zip,
                level: 'U',
                
                // Set Parent Flag 
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

            // Start try block to catch errors
            try {
                // Logic Branch
                if (isParent === 'on') {
                    // PArent Go to Add Participant (for their child)
                    res.redirect('/participants/add'); 

                } else {
                    // Studnet Auto create Participant record
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
                // Catch block to handle the error safely
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

// --- Login Routes ---
app.get("/login", (req, res) => {
    res.render("login");
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        // Basic Validation
        if (!username || !password) {
            return res.render('login', { error: 'Username and password are required.' });
        }

        // Fetch user from Database
        // use lowercase to ensure case insensitive matching
        const user = await knex('users').where({ username: username.toLowerCase() }).first();

        // Check if User Exists & Password Matches
        
        if (!user || user.password !== password) {
            return res.render('login', { error: 'Invalid username or password.' });
        }

        // Set Session Variables
        req.session.username = user.username;
        req.session.firstName = user.firstname;
        req.session.level = user.level;     // M or U
        req.session.isParent = user.parentflag; // True or False

        // Save Session & Redirect
        req.session.save(err => {
            if (err) console.error("Session save error:", err);
            
            // Redirect Manager to Dashboard adn everyone else to Home
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
// 6. Protected User Routes
// =========================================

app.get("/admin/dashboard", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    if (req.session.level !== 'M') return res.redirect('/');

    try {
        //  Count Total Participants
        const partResult = await knex('participants').count('participantid as count').first();
        const participantCount = partResult.count;

        //  Count Active Upcoming Events
        const eventResult = await knex('event_schedule')
            .where('eventdatetimestart', '>=', new Date())
            .count('scheduleid as count')
            .first();
        const eventCount = eventResult.count;

        //  Count Survey Responses
        const surveyResult = await knex('surveys').count('surveyid as count').first();
        const surveyCount = surveyResult.count;

        //  Sum Total Donations
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

// --- Account Management Routes ---

// Show Account Page
app.get("/account", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        // Fetch User Details
        const user = await knex('users').where({ username: req.session.username }).first();
        
        // Fetch Linked Participant Details for School or Interest fields
        const participant = await knex('participants').where({ username: req.session.username }).first();

        // Data Mapping for Header View
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

// Process Account Update
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

        // --- Update Users Table ---
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

        // --- 2. Update Participants Table If they have one ---
        // Only update participant details if they are NOT a parent (Students usually update their own info)
        // OR if you want parents to update their own "Participant" record if they have one.
        // Safe bet: Update it if it exists.
        const hasParticipantRecord = await knex('participants').where({ username: currentUser.username }).first();
        
        if (hasParticipantRecord) {
            await knex('participants')
                .where({ username: currentUser.username }) // This assumes username didn't change yet or cascade handles it
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

// --- Participants ---

// List Participants With Search
app.get("/participants", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    // Get Search Params
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

        // Apply Search Filters
        if (firstName) {
            query = query.where('participantfirstname', 'ilike', `%${firstName}%`);
        }
        if (lastName) {
            query = query.where('participantlastname', 'ilike', `%${lastName}%`);
        }
        if (username) {
            query = query.where('username', 'ilike', `%${username}%`);
        }

        // Apply Sorting
        // If Parent: Show their linked kids with matching username FIRST 0 everyone else Second 1
        if (req.session.isParent) {
            query = query.orderByRaw(`CASE WHEN username = ? THEN 0 ELSE 1 END`, [req.session.username]);
        }
        query = query.orderBy('participantid', 'desc'); // Secondary sort

        // Execute Query
        const participants = await query;

        // Fetch Milestones
        const milestoneCounts = await knex('milestones')
            .select('participantid')
            .count('milestoneid as count')
            .groupBy('participantid');

        // Merge counts
        participants.forEach(p => {
            const match = milestoneCounts.find(m => m.participantid == p.participantid);
            p.milestone_count = match ? match.count : 0;
        });

        // Render with Search Terms
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

//  Get Add Form
app.get("/participants/add", (req, res) => {
    if (!req.session.username || (req.session.level !== 'M' && !req.session.isParent)) {
        return res.redirect('/participants');
    }
    res.render("addParticipant");
});

//  Post Add Form
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

//  Get Edit Form Smart Permissions and  Autofill Data
app.get("/participants/edit/:id", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        const participant = await knex('participants').where({ participantid: req.params.id }).first();
        
        if (!participant) return res.redirect('/participants');

        // Permission Check:
        // You can edit when  Manager Or You are the Parent linked to this kid
        const isOwner = participant.username === req.session.username;
        const isManager = req.session.level === 'M';

        if (!isManager && !isOwner) {
            return res.redirect('/participants');
        }
        
        // Render the edit template
        res.render("editParticipant", { participant }); 

    } catch (err) {
        console.error("Error finding participant:", err);
        res.redirect('/participants');
    }
});

// Post Edit Form 
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
        // Parents can't accidentally unlink their kids
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

//  Delete Participant Manager Only Safety First
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

// --- Event Routes ---

// View Events selects eventid for the Edit button
app.get("/events", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    // Get Search Params
    const { searchEvent, searchLocation } = req.query;

    try {
        // Get All Events 
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

        // Apply Filters
        if (searchEvent) {
            query = query.where('events.eventname', 'ilike', `%${searchEvent}%`);
        }
        if (searchLocation) {
            query = query.where('event_schedule.eventlocation', 'ilike', `%${searchLocation}%`);
        }

        // Execute Query
        const allEvents = await query.orderBy('event_schedule.eventdatetimestart', 'asc');

        const now = new Date();
        const upcoming = allEvents.filter(e => new Date(e.eventdatetimestart) >= now);
        const past = allEvents.filter(e => new Date(e.eventdatetimestart) < now).reverse();

        // Get Linked Participants
        const myParticipants = await knex('participants')
            .where({ username: req.session.username })
            .select('participantid', 'participantfirstname', 'participantlastname');

        // Get My Registration
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

        // Create Lookup Set
        const registeredSet = new Set(
            rawRegistrations.map(r => `${r.scheduleid}-${r.participantid}`)
        );

        //Group My Events
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
            // Pass Search Terms Back
            searchEvent: searchEvent || '',
            searchLocation: searchLocation || ''
        });

    } catch (err) {
        console.error("Error fetching events:", err);
        res.render("events", { upcoming: [], past: [], myParticipants: [], myRegistrations: [], registeredSet: new Set(), searchEvent: '', searchLocation: '' }); 
    }
});

// Register and sync Handles Checkboxes & Single Buttons
app.post("/events/register", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { scheduleId, participantId } = req.body;

    try {
        if (req.session.isParent) {
            // --- Parent sync  ---
            
            //  Get List of IDs wanted 
            const requestedIds = new Set(
                (Array.isArray(participantId) ? participantId : [participantId])
                .filter(Boolean) // remove null and undefined
                .map(id => parseInt(id))
            );

            // Get all kids belonging to this parent 
            const myKids = await knex('participants')
                .where({ username: req.session.username })
                .select('participantid');

            // 3. Loop through Each kid and Sync status
            for (const kid of myKids) {
                if (requestedIds.has(kid.participantid)) {
                    // Want: Register Insert if not exists
                    await knex('registrations').insert({
                        scheduleid: scheduleId,
                        participantid: kid.participantid
                    }).onConflict(['participantid', 'scheduleid']).ignore();
                } else {
                    // Dont Want: Unregister Delete if exists
                    await knex('registrations')
                        .where({ scheduleid: scheduleId, participantid: kid.participantid })
                        .del();
                }
            }

        } else {
            // --- Student Mode Single Add ---
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

// 3. Unregister For Student Leave Button or specific cancel
app.post("/events/unregister", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');
    
    const { registrationId, scheduleId, participantId } = req.body;

    try {
        if (registrationId) {
            // Delete by Registration ID from the Events list
            await knex('registrations').where({ registrationid: registrationId }).del();
        } else if (scheduleId && participantId) {
            // Delete by Event and User from Student Toggle Button
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

// Get Edit Event Form Manager Only
app.get("/events/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/events');

    try {
        // Fetch the event to pre-fill the form
        // Join with event schedule 
        const event = await knex('events')
            .join('event_schedule', 'events.eventid', '=', 'event_schedule.eventid')
            .where({ 'events.eventid': req.params.id })
            .select(
                'events.*',
                'event_schedule.eventdatetimestart as eventdate', // name to match view expectation
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

// Post Edit Event Manager Only
app.post("/events/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { eventName, eventType, eventDescription, eventdate, eventLocation } = req.body;

    try {
        // Update the generic event details
        await knex('events')
            .where({ eventid: req.params.id })
            .update({
                eventname: eventName,
                eventtype: eventType,
                eventdescription: eventDescription
            });

        // Update the specific schedule details
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

// Delete Event Manager Only
app.post("/events/delete/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    try {
        // Deleting the event will delete the registrations automatically
        await knex('events').where({ eventid: req.params.id }).del();
        res.redirect('/events');
    } catch (err) {
        console.error("Error deleting event:", err);
        res.redirect('/events');
    }
});

// --- Surveys ---

app.get("/surveys", (req, res) => {
    res.redirect("/survey"); 
});

// Show Survey Form 
app.get("/survey", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        // Get The logged in users linked participants
        const myParticipants = await knex('participants')
            .where({ username: req.session.username })
            .select('participantid', 'participantfirstname', 'participantlastname');

        // Get All past events
        // Linking event schedule to events to get the name
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

// Submit Survey Fixed to use schedule id participant id
app.post("/survey/submit", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    
    const { participantId, scheduleId, satisfaction, usefulness, recommendation, comments } = req.body;

    try {
        // Check if a registration  exists for kid and event
        // search the registrations table 
        let registration = await knex('registrations')
            .where({ scheduleid: scheduleId, participantid: participantId })
            .first();

        // If not registered yet register them Walk in logic
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

        // Calculate NPS Bucket 
        let npsBucket = 'Passive';
        const recScore = parseInt(recommendation);
        if (recScore >= 5) npsBucket = 'Promoter';
        if (recScore <= 3) npsBucket = 'Detractor';

        // Insert Survey Using schedule id and participant id, Not registration id
        await knex('surveys').insert({
            scheduleid: scheduleId,       
            participantid: participantId, 
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

// admin view responses
// ==========================================
// Update: Events Route 
// ==========================================
app.get("/events", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    // Get search paramaters
    const { searchEvent, searchLocation } = req.query;

    try {
        // Get All Events 
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

        // Apply Filters
        if (searchEvent) {
            query = query.where('events.eventname', 'ilike', `%${searchEvent}%`);
        }
        if (searchLocation) {
            query = query.where('event_schedule.eventlocation', 'ilike', `%${searchLocation}%`);
        }

        // Execute Query
        const allEvents = await query.orderBy('event_schedule.eventdatetimestart', 'asc');

        const now = new Date();
        const upcoming = allEvents.filter(e => new Date(e.eventdatetimestart) >= now);
        const past = allEvents.filter(e => new Date(e.eventdatetimestart) < now).reverse();

        // Get Linked Participants
        const myParticipants = await knex('participants')
            .where({ username: req.session.username })
            .select('participantid', 'participantfirstname', 'participantlastname');

        // Get My Registrations
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

        //  Create Lookup Set
        const registeredSet = new Set(
            rawRegistrations.map(r => `${r.scheduleid}-${r.participantid}`)
        );

        // Group My Events
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
            // Pass Search Terms Back
            searchEvent: searchEvent || '',
            searchLocation: searchLocation || ''
        });

    } catch (err) {
        console.error("Error fetching events:", err);
        res.render("events", { upcoming: [], past: [], myParticipants: [], myRegistrations: [], registeredSet: new Set(), searchEvent: '', searchLocation: '' }); 
    }
});

// ==========================================
// update: Donations Route 
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
// update surveys route 
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

// Delete Survey Manager Only
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

//  Get Edit Survey Form Manager Only
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

// Post Edit Survey Manager Only
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

// --- Milestones ---

// List All Milestones With Search Managers Only 
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



// View Details Specific Participant 
app.get("/milestones/view/:id", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    try {
        const participant = await knex('participants').where({ participantid: req.params.id }).first();
        if (!participant) return res.redirect('/participants');

        // Permission Check Manager Or Owner
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

// add Milestone  Allows Manager Or Owner
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

// add Milestone Allows Manager OR Owner
app.post("/milestones/add/:id", async (req, res) => {
    if (!req.session.username) return res.redirect('/login');

    const { milestoneTitle, milestoneDate, notes } = req.body;

    try {
        // Double check permission on Post
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

//Edit Milestone Allows Manager Or Owner
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

// edit Milestone Allows Manager OR Owner
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

// Delete milestone Allows Manager OR Owner
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

// --- Donation routes ---

// Show the Donation Form
app.get("/donate", (req, res) => {
    res.render("donations", { error: null });
});

// Process the Donation Form
app.post('/donate', async (req, res) => {
    const { firstName, lastName, email, amount } = req.body;

    try {
        // Check if participant already exists by email
        const participant = await knex('participants').where({ participantemail: email }).first();
        let participantId;

        if (!participant) {
            // If participant doesn't exist, create a new record
            
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
        
        // Log the donation transaction
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

// --- Admin Donation Routes ---

// list Donation
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

// Show Add Donation Form 
app.get("/admin/donations/add", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    // Get query params Search terms and Selected User id
    const { firstName, lastName, username, selectedId } = req.query;
    
    let participants = [];
    let selectedParticipant = null;

    try {
        // If a user was selected, fetch their details
        if (selectedId) {
            selectedParticipant = await knex('participants')
                .where({ participantid: selectedId })
                .first();
        }

        // If search terms exist, run the search
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

// Process Add Donation
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

// show Edit Form 
app.get("/admin/donations/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { firstName, lastName, username, selectedId } = req.query;

    try {
        // Fetch the Donation Record
        const donation = await knex('donations').where({ donationid: req.params.id }).first();
        if (!donation) return res.redirect('/admin/donations');

        // Determine the "Selected Participant" The one displayed in the form
        
        let selectedParticipant = await knex('participants')
            .where({ participantid: donation.participantid })
            .first();

        //  If user clicked "Select" on a search result, use that ID instead
        if (selectedId) {
            const newSelection = await knex('participants')
                .where({ participantid: selectedId })
                .first();
            if (newSelection) {
                selectedParticipant = newSelection;
            }
        }

        // Handle Search Results 
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

        // Render
        res.render("editDonation", { 
            donation, 
            selectedParticipant, 
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

// process edit
app.post("/admin/donations/edit/:id", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    
    const { participantId, amount, date, notes } = req.body;

    try {
        await knex('donations')
            .where({ donationid: req.params.id })
            .update({
                participantid: participantId, 
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

// Delete Donation
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
// Admin User Maintenece
// =========================================

// List Users
// --- User Maintenence Routes  ---

// List All Users 
app.get("/admin/users", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    // Get search params from URL
    const { firstName, lastName, username } = req.query;

    try {
        // Start building the query
        let query = knex('users').select('*').orderBy('username');

        // Apply filters 
        if (firstName) {
            query = query.where('firstname', 'ilike', `%${firstName}%`);
        }
        if (lastName) {
            query = query.where('lastname', 'ilike', `%${lastName}%`);
        }
        if (username) {
            query = query.where('username', 'ilike', `%${username}%`);
        }

        // Execute query
        const users = await query;

        // Render with search terms passed back
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

// --- Admin User Maintence Routes ---

// Show Add User Form
app.get("/admin/users/add", (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');
    res.render("addUser");
});

// Process Add User
app.post("/admin/users/add", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { 
        username, password, firstname, lastname, email, 
        phone, dob, city, state, zip, level, parentflag,
        schoolOrEmployer, fieldOfInterest 
    } = req.body;

    try {
        // Check for duplicates
        const existingUser = await knex('users')
            .where({ username: username.toLowerCase() })
            .orWhere({ email: email.toLowerCase() })
            .first();

        if (existingUser) {
            return res.send("Error: Username or Email already exists.");
        }

        // Perform Database Inserts
        await knex.transaction(async (trx) => {
            
            // Insert into Users table
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

                parentflag: parentflag === 'on'
            });

            // If they are a standard User and npt a parent, create a Participant record
            if (level === 'U' && parentflag !== 'on') {
                
                // Ensure Zip Code exists
                if (zip) {
                    await trx('zip_codes')
                        .insert({ zip, city, state })
                        .onConflict('zip')
                        .ignore();
                }

                // Create Linked Participant Record
                await trx('participants').insert({
                    username: username.toLowerCase(), 
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

// Show Edit Form 
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

// Process Edit User 
app.post("/admin/users/edit/:username", async (req, res) => {
    if (!req.session.username || req.session.level !== 'M') return res.redirect('/');

    const { firstname, lastname, email, phone, city, state, zip, password, level, username } = req.body;

    try {
        const updateData = {
            username: username.toLowerCase(), 
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

       
        await knex('users').where({ username: req.params.username }).update(updateData);
        
        res.redirect('/admin/users');
    } catch (err) {
        console.error("Error updating user:", err);
        res.send("Error updating user.");
    }
});

// Delete User 
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
    // Security Check
    if (!req.session.username) {
        return res.redirect('/login');
    }
    res.status(418).render("teapot");
});

// =========================================
// Server start
// =========================================
app.listen(port, () => console.log(`Server running on port ${port}`));