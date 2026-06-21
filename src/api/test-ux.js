const { exec } = require('child_process');

app.post('/ping', (req, res) => {
    const targetIp = req.body.ip;
    // CRITICAL: Command Injection payload
    exec("ping -c 4 " + targetIp, (err, stdout) => {
        res.send(stdout);
    });
});
