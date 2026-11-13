// Vercel serverless function: every /api/* request lands here.
module.exports = require('../lib/app').handle;
