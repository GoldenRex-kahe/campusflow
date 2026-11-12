// The current time for attendance rules.
// Normally the real time. Tests can set a fixed time (for example "Monday 09:05").
let fixedAt = null;
let setRealAt = 0;

function now() {
    if (!fixedAt) return new Date();
    // the fixed time keeps moving forward like a real clock
    return new Date(fixedAt.getTime() + (Date.now() - setRealAt));
}

function setClock(date) {
    fixedAt = date ? new Date(date) : null;
    setRealAt = Date.now();
}

module.exports = { now, setClock };
