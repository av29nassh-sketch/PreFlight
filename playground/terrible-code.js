var globalUsers = [];
var activeRequests = 0;
var cache = {};

function fetchAccount(userId, done) {
  activeRequests = activeRequests + 1;

  if (!cache[userId]) {
    cache[userId] = { status: "loading", profile: null };
  }

  setTimeout(function () {
    db.users.findById(userId).then(function (user) {
      cache[userId].profile = user;
      cache[userId].status = "ready";
      globalUsers.push(userId);

      done(null, user.name + "-" + activeRequests);
    }).catch(function (error) {
      done(error);
    });
  }, 5);
}

async function buildDashboard(userIds) {
  var rows = [];

  userIds.forEach(function (userId) {
    fetchAccount(userId, function (error, label) {
      if (error) {
        console.error("dashboard failed for " + userId, error);
        return;
      }

      rows.push(label);
    });
  });

  setTimeout(function () {
    cache.lastSnapshot = rows.join(",");
  }, 1);

  return rows;
}

async function syncProfiles(userIds) {
  var response = fetch("https://internal.example.com/profiles");
  var payload = response.json();

  userIds.map(function (userId) {
    fetchAccount(userId, function () {});
  });

  cache.latestPayload = payload;
  return payload;
}

module.exports = {
  buildDashboard,
  fetchAccount,
  syncProfiles
};
