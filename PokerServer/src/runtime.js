function createRuntime() {
    return {
        roomGames: {},
        lobbySockets: new Set(),
        inviteCodeFailuresByUser: new Map(),
        inviteCodeFailuresByIp: new Map()
    };
}

module.exports = { createRuntime };
