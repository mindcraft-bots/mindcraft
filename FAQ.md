# Common Issues
- `Error: connect ECONNREFUSED`: Minecraft refused to connect with mindcraft program. Most likely due to:
  - you have not opened your game to LAN in game settings
  - your LAN port is incorrect, make sure the one you enter in game is the same as specified in `settings.js`
  - you have the wrong version of minecraft, make sure your MC version is the same as specified in `settings.js`

- `ERR_MODULE_NOT_FOUND`: You are missing an npm package. run `npm install`

- Many issues are caused by out-of-date node module patches, especially after updates. A catch-all is to delete the `node_modules` folder, and run `npm install`

- **`npm install` fails with Python or C++ build errors**: This typically happens when building native modules like `canvas` or `gl`. Common solutions:
  - **Termux & Low-RAM Linux**: Simply skip the optional native modules:
    ```bash
    npm install --omit=optional
    ```
    Vision is completely optional. Mindcraft will run at 100% functionality for conversations, mining, crafting, fighting, and building without native canvas/gl dependencies!
  - **Python not found** (macOS/Linux): If you see `python: command not found`, create a symlink: `sudo ln -s $(which python3) /usr/local/bin/python`
  - **C++20 errors or Node version issues**: If you see `"C++20 or later required"` errors, you're likely using Node v24 or newer. The `gl` package requires Node LTS (v18 or v20). Switch versions using:
    ```bash
    nvm install 20
    nvm use 20
    rm -rf node_modules package-lock.json
    npm install --omit=optional
    ```

- `My brain disconnected, try again`: Something is wrong with the LLM api. You may have the wrong API key, exceeded your rate limits, or other. Check the program outputs for more details.
  - **Tip: Multi-key rotation**: You can supply multiple API keys for any provider in `keys.json` (as an array `["key1", "key2"]` or comma-separated `"key1,key2"`). The bot will automatically rotate to the next key if a rate limit (429) occurs!

- **Running on Linux with 4GB RAM**:
  - Run with `npm run start:low-mem` or `./start-low-memory.sh` (or `node --max-old-space-size=1536 main.js --low-memory`).
  - This sets V8 heap limits, enables periodic chunk pruning in Mineflayer, and triggers garbage collection to avoid triggering the Linux OOM killer.

- **Running on Termux (Android)**:
  - Run `./termux-setup.sh` for one-step installation.
  - Run `./termux-start.sh` or `npm run start:termux` to launch.
  - Canvas and headless GL are automatically bypassed, and memory is constrained to 1024MB to prevent Android from killing the terminal session.

- **How to make the bot respond as fast as possible?**:
  - Use high-speed inference providers like **Groq**, **Cerebras**, or **SambaNova**.
  - In `settings.js`, ensure `"fast_mode": true` is enabled (it is on by default).
  - Use `./profiles/fast.json`, `./profiles/cerebras.json`, `./profiles/sambanova.json`, or `./profiles/groq.json`.
  - Cooldown delay is reduced to 0 in fast mode, and memories are summarized in the background so the bot responds in real-time.
  
- `I'm stuck!` or other issues with constantly getting stuck:
  - Mineflayer's pathfinder is imperfect. We have improved upon it with patches, but these might not have been applied properly. Make sure your code is up to date with main, delete the `node_modules` folder, and run `npm install`
  - The bot will still get stuck occasionally, but not constantly.
    
- `Why I added the api key but still prompted that the key can't be found?`
  - Possible reason 1: Did not modify keys.example.json to keys.json.
  - Possible reason 2: If you use vscode to edit, you need to `ctrl+s` to save the file for the changes to take effect.
  - Possible reason 3: Not setting the code path correctly in setting.js, use andy.js by default. 

# Common Questions
- Mod Support? Mindcraft only supports client-side mods like optifine and sodium, though they can be tricky to set up. Mods that change minecraft game mechanics are not supported.
  
- Texture Packs? Apparently these cause issues and refuse to connect. Not sure why
  
- Baritone? Baritone is a mod that is completely different from mineflayer. There is currently no easy way to integrate the two programs.
