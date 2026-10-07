import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

export class AgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
    }

    start(load_memory=false, init_message=null, count_id=0) {
        this.count_id = count_id;
        this.running = true;

        // more heap than node's ~4 GB default, as headroom for big path searches. on a small machine that also runs
        // the Minecraft server, cap it lower (MINDCRAFT_MAX_HEAP_MB): one runaway grew the bot to 6.5 GB on a 7.6 GB
        // box, swapped the server out and crashed it. capped, only the bot dies, and it restarts
        const heap_mb = parseInt(process.env.MINDCRAFT_MAX_HEAP_MB) || 8192;
        let args = [`--max-old-space-size=${heap_mb}`, init_agent_path, this.name];
        args.push('-n', this.name);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', this.port);

        const agentProcess = spawn(process.execPath, args, {
            stdio: 'inherit',
            stderr: 'inherit',
        });
        
        let last_restart = Date.now();
        agentProcess.on('exit', (code, signal) => {
            console.log(`Agent process exited with code ${code} and signal ${signal}`);
            this.running = false;
            logoutAgent(this.name);
            
            // small codes above 1 are the agent deliberately ending the task. crashes exit with 128 and up (134 when
            // node runs out of memory) and a forced kill on Windows with 4294967295: restart those like code 1
            if (code > 1 && code < 128) {
                console.log(`Ending task`);
                process.exit(code);
            }

            if (code !== 0 && signal !== 'SIGINT') {
                // dying within 10 seconds is usually the server being down (it crashed at 3:35 one night and the bot
                // gave up after one try, leaving the run stalled for 3 hours). keep trying every 30 seconds, and after
                // half an hour end the process so a runner can start afresh
                if (Date.now() - last_restart < 10000) {
                    this.quick_fails = (this.quick_fails || 0) + 1;
                    if (this.quick_fails > 60) {
                        console.error(`Agent process keeps exiting straight away, giving up.`);
                        process.exit(1);
                    }
                    console.error(`Agent process exited too quickly (${this.quick_fails} in a row), trying again in 30 seconds.`);
                    setTimeout(() => this.start(true, 'Agent process restarted.', count_id, this.port), 30000);
                    return;
                }
                this.quick_fails = 0;
                console.log('Restarting agent...');
                this.start(true, 'Agent process restarted.', count_id, this.port);
                last_restart = Date.now();
            }
        });
    
        agentProcess.on('error', (err) => {
            console.error('Agent process error:', err);
        });

        this.process = agentProcess;
    }

    stop() {
        if (!this.running) return;
        this.process.kill('SIGINT');
    }

    forceRestart() {
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);
            
            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000); // 5 seconds to exit

            this.process.once('exit', () => {
                 clearTimeout(restartTimeout);
                 console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                 this.start(true, 'Agent process restarted.', this.count_id);
            });
            this.stop(); // sends SIGINT
        } else {
             this.start(true, 'Agent process restarted.', this.count_id);
        }
    }
}