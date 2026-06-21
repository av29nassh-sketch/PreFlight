const express = require("express");
const { execFile } = require("child_process");

const router = express.Router();

router.post("/network/lookup", (req, res) => {
  const domain = req.body.domain;

  if (!domain || typeof domain !== "string") {
    return res.status(400).send("Invalid domain");
  }

  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!domainRegex.test(domain)) {
    return res.status(400).send("Invalid domain format");
  }

  execFile("nslookup", [domain], (error, stdout) => {
    if (error) {
      return res.status(500).send("Lookup failed");
    }

    return res.send(stdout);     
  });
});

const app = express();
app.use(express.json());

app.post('/ping', (req, res) => {
    const targetIp = req.body.ip;
    
    if (!targetIp || typeof targetIp !== "string") {
        return res.status(400).send("Invalid IP address");
    }
    
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (!ipRegex.test(targetIp)) {
        return res.status(400).send("Invalid IP address format");
    }
    
    execFile("ping", ["-c", "4", targetIp], (err, stdout) => { 
        if (err) {
            return res.status(500).send("Ping failed");
        }
        res.send(stdout); 
    });
});

module.exports = router;