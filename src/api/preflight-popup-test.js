const express = require("express");
const { execFile } = require("child_process");
const { isIP } = require("net");

const router = express.Router();

router.post("/preflight-popup-test", (req, res) => {
  const targetIp = req.body.ip;
  
  if (!targetIp || !isIP(targetIp)) {
    return res.status(400).send("Invalid IP address");
  }

  execFile("ping", ["-c", "4", targetIp], (error, stdout, stderr) => {
    if (error) {
      return res.status(500).send("Ping failed");
    }
    res.send(stdout);
  });
});

module.exports = router;
