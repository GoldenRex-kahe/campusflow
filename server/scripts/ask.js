// Ask a question in the terminal.
// hidden: true shows * instead of the letters you type (for passwords).
const readline = require("readline");

function ask(question, { hidden = false } = {}) {
    if (hidden) return askHidden(question);

    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// reads one key at a time, so the typed letters are never printed
function askHidden(question) {
    return new Promise((resolve, reject) => {
        const input = process.stdin;
        if (!input.isTTY) {
            reject(new Error("Run this in a terminal window so the password can be typed hidden"));
            return;
        }

        process.stdout.write(question);
        let answer = "";
        input.setRawMode(true);
        input.resume();
        input.setEncoding("utf8");

        function finish() {
            input.setRawMode(false);
            input.pause();
            input.removeListener("data", onData);
            process.stdout.write("\n");
        }

        function onData(chunk) {
            for (const ch of chunk) {
                if (ch === "\r" || ch === "\n") {          // Enter
                    finish();
                    resolve(answer);
                    return;
                }
                if (ch === "\u0003") {                     // Ctrl+C
                    finish();
                    process.exit(1);
                }
                if (ch === "\u0008" || ch === "\u007f") {  // Backspace
                    if (answer.length > 0) {
                        answer = answer.slice(0, -1);
                        process.stdout.write("\b \b");
                    }
                    continue;
                }
                if (ch >= " ") {                           // a normal character
                    answer += ch;
                    process.stdout.write("*");
                }
            }
        }

        input.on("data", onData);
    });
}

module.exports = { ask };
