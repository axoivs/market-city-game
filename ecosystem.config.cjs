module.exports = {
  apps: [{
    name: "market-city-game",
    script: "./server.js",
    cwd: "/var/www/market-city-game",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_memory_restart: "700M",
    env: {
      NODE_ENV: "production",
      PORT: "3000"
    }
  }]
};
