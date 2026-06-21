const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');

router.post('/payment-webhook-test', (req, res) => {
    const paymentProviderHost = req.body.host;
    
    if (!paymentProviderHost || typeof paymentProviderHost !== 'string') {
        return res.status(400).send("Invalid host parameter");
    }
    
    const hostPattern = /^[a-zA-Z0-9.-]+$/;
    if (!hostPattern.test(paymentProviderHost)) {
        return res.status(400).send("Invalid host format");
    }

    execFile('ping', ['-c', '4', paymentProviderHost], (error, stdout) => {
        if (error) return res.status(500).send("Payment provider health check failed");
        res.send(stdout);
    });
});

module.exports = router;
