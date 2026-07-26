function createRuntime() {
    return {
        roomGames: {},
        shuttingDown: false,
        lobbySockets: new Set(),
        inviteCodeFailuresByUser: new Map(),
        inviteCodeFailuresByIp: new Map()
    };
}

module.exports = { createRuntime };
