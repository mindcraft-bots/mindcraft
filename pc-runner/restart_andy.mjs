// Restarts the agent process through the MindServer so code changes load without ending the run: the agent comes
// back with its memory, its in-game inventory is untouched, and the task's goal and splits carry on.
// Don't kill the agent process instead: on Windows that exits with a code above 1, which ends the whole task.
//   node tmp/restart_andy.mjs [agent name] [mindserver port]
import { io } from 'socket.io-client';

const name = process.argv[2] || 'andy';
const port = process.argv[3] || 8080;
const socket = io(`http://localhost:${port}`);
socket.on('connect', () => {
    socket.emit('restart-agent', name);
    console.log(`Asked the MindServer to restart ${name}.`);
    setTimeout(() => process.exit(0), 500);
});
socket.on('connect_error', (err) => {
    console.error(`Couldn't reach the MindServer on port ${port}: ${err.message}`);
    process.exit(1);
});
