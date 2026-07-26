'use strict';

const { createDatabaseService } = require('./src/storage/database-service');

const db = createDatabaseService({ baseDir: __dirname });

module.exports = db;
module.exports.createDatabaseService = createDatabaseService;
