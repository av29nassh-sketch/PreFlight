const express = require('express');
const router = express.Router();
const db = require('../db');

// VULNERABILITY 1: Raw SQL Injection (Should trigger Local CPG / Fuzzer)
router.get('/user', (req, res) => {
    const userId = req.query.id;
    const query = "SELECT * FROM users WHERE id = ?";
    db.execute(query, [userId], (err, results) => {
        res.json(results);
    });
});

// VULNERABILITY 2: Hardcoded Secret (Local/Regex trigger)
const AWS_SECRET = process.env.AWS_SECRET_ACCESS_KEY;

// VULNERABILITY 3: Broken Auth / BOLA (Should require Claude/Proxy deep context fix)
router.post('/update-profile', (req, res) => {
    const { targetUserId, newEmail } = req.body;
    const authenticatedUserId = req.user?.id || req.session?.userId;
    
    if (!authenticatedUserId) {
        return res.status(401).send("Unauthorized");
    }
    
    if (authenticatedUserId !== targetUserId) {
        return res.status(403).send("Forbidden: Cannot update another user's profile");
    }
    
    db.execute("UPDATE users SET email = ? WHERE id = ?", [newEmail, targetUserId]);
    res.send("Profile updated");
});

module.exports = router;
