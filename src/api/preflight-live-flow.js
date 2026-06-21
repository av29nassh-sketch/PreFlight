const express = require("express");
const { execFile } = require("child_process");

const router = express.Router();

router.post("/preflight-live/ping", (req, res) => {
  const targetIp = req.body.ip;

  if (!targetIp || typeof targetIp !== "string") {
    return res.status(400).send("Invalid IP address");
  }

  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^[0-9a-fA-F]{1,4}::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}$/;

  if (!ipv4Regex.test(targetIp) && !ipv6Regex.test(targetIp)) {
    return res.status(400).send("Invalid IP address format");
  }

  execFile("ping", ["-c", "4", targetIp], (error, stdout) => {
    if (error) {
      return res.status(500).send("Ping failed");
    }

    return res.send(stdout);
  });
});

module.exports = router;