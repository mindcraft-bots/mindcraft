import {Vec3} from 'vec3';

export class ConstructionTaskValidator {
    constructor(data, agent) {
        this.blueprint = new Blueprint(data.blueprint);
        this.agent = agent;
    }
    validate() {
        try {
            //todo: somehow make this more of a percentage or something
            // console.log('Validating task...');
            let valid = false;
            let score = 0;
            let result = this.blueprint.check(this.agent.bot);
            if (result.mismatches.length === 0) {
                valid = true;
                console.log('Task is complete');
            }
            let total_blocks = result.mismatches.length + result.matches.length;
            score = (result.matches.length / total_blocks) * 100;
            console.log(`Task score: ${score}%`);
            return {
                "valid": valid, 
                "score": score
            };
        } catch (error) {
            console.error('Error validating task:', error);
            return {
                "valid": false,
                "score": 0
            };
        }
    }
}

export function resetConstructionWorld(bot, blueprint) {
    console.log('Resetting world...');
    const starting_position = blueprint.levels[0].coordinates;
    const length = blueprint.levels[0].placement.length + 5;
    const height = blueprint.levels.length + 5;
    const width = blueprint.levels[0].placement[0].length + 5;
    const command = `/fill ${starting_position[0]} ${starting_position[1]} ${starting_position[2]} ${starting_position[0] + width} ${starting_position[1] + height} ${starting_position[2] + length} air`;
    bot.chat(command);
    console.log('World reset');
}

export function checkLevelBlueprint(agent, levelNum) {
    const blueprint = agent.task.blueprint;
    const bot = agent.bot;
    const result = blueprint.checkLevel(bot, levelNum);
    if (result.mismatches.length === 0) {
        return `Level ${levelNum} is correct`;
    } else {
        let explanation = blueprint.explainLevelDifference(bot, levelNum);
        return explanation;
    }
}

export function checkBlueprint(agent) {
    console.log('Checking blueprint...');
    console.log(agent);
    const blueprint = agent.task.blueprint;
    const bot = agent.bot;
    const result = blueprint.check(bot);
    if (result.mismatches.length === 0) {
        return "Blueprint is correct";
    } else {
        let explanation = blueprint.explainBlueprintDifference(bot);
        return explanation;
    }
}

export class Blueprint {
    constructor(blueprint) {
        this.data = blueprint;
    }
    explain() {
        var explanation = "";

        for (let item of this.data.levels) {
            var coordinates = item.coordinates;
            explanation += `Level ${item.level}: `;
            explanation += `Start at coordinates X: ${coordinates[0]}, Y: ${coordinates[1]}, Z: ${coordinates[2]}`;
            // let placement_string = this._getPlacementString(item.placement);
            // explanation += `\n${placement_string}\n`;
        }
        return explanation;
    }
    _getPlacementString(placement) {
        var placement_string = "[\n";
        for (let row of placement) {
            placement_string += "[";
            for (let i = 0; i < row.length - 1; i++) {
                let item = row[i];
                placement_string += `${item}, `;
            }
            let final_item = row[row.length - 1];
            placement_string += `${final_item}],\n`;
        }
        placement_string += "]";
        return placement_string;
    }
    explainLevel(levelNum) {
        const levelData = this.data.levels[levelNum];
        var explanation = `Level ${levelData.level} `;
        explanation += `starting at coordinates X: ${levelData.coordinates[0]}, Y: ${levelData.coordinates[1]}, Z: ${levelData.coordinates[2]}`;
        let placement_string = this._getPlacementString(levelData.placement);
        explanation += `\n${placement_string}\n`;
        return explanation;
    }
    explainBlueprintDifference(bot) {
        var explanation = "";
        const levels = this.data.levels;
        for (let i = 0; i < levels.length; i++) {
            let level_explanation = this.explainLevelDifference(bot, i);
            explanation += level_explanation + "\n";
        }
        return explanation;
    }
    explainLevelDifference(bot, levelNum) {
        const results = this.checkLevel(bot, levelNum);
        const mismatches = results.mismatches;
        const levelData = this.data.levels[levelNum];

        if (mismatches.length === 0) {
            return `Level ${levelData.level} is complete`;
        }
        var explanation = `Level ${levelData.level} `;
        // explanation += `at coordinates X: ${levelData.coordinates[0]}, Y: ${levelData.coordinates[1]}, Z: ${levelData.coordinates[2]}`;
        explanation += " requires the following fixes:\n";
        for (let item of mismatches) {
            if (item.actual === 'air') { 
                explanation += `Place ${item.expected} at coordinates X: ${item.coordinates[0]}, Y: ${item.coordinates[1]}, Z: ${item.coordinates[2]}\n`;
            } else if (item.expected === 'air') {
                explanation += `Remove the ${item.actual} at coordinates X: ${item.coordinates[0]}, Y: ${item.coordinates[1]}, Z: ${item.coordinates[2]}\n`;
            } else {
                explanation += `Replace the ${item.actual} with a ${item.expected} at coordinates X: ${item.coordinates[0]}, Y: ${item.coordinates[1]}, Z: ${item.coordinates[2]} \n`;
            }
        }
        return explanation;
    }
    check(bot) {
        if (!bot || typeof bot !== 'object' || typeof bot.blockAt !== 'function') {
            throw new Error('Invalid bot object. Expected a mineflayer bot.');
        }
        const levels = this.data.levels;
        const mismatches = [];
        const matches = [];
        for (let i = 0; i < levels.length; i++) {
            const result = this.checkLevel(bot, i);
            mismatches.push(...result.mismatches);
            matches.push(...result.matches);
        }
        return {
            "mismatches": mismatches,
            "matches": matches
        };
    }
    checkLevel(bot, levelNum) {
        const levelData = this.data.levels[levelNum];
        const startCoords = levelData.coordinates;
        const placement = levelData.placement;
        const mismatches = [];
        const matches = [];
    
        for (let zOffset = 0; zOffset < placement.length; zOffset++) {
            const row = placement[zOffset];
            for (let xOffset = 0; xOffset < row.length; xOffset++) {
                const blockName = row[xOffset];
    
                const x = startCoords[0] + xOffset;
                const y = startCoords[1];
                const z = startCoords[2] + zOffset;

                try {
                    const blockAtLocation = bot.blockAt(new Vec3(x, y, z));
                    const actualBlockName = blockAtLocation ? bot.registry.blocks[blockAtLocation.type].name : "air";

                    // Skip if both expected and actual block are air
                    if (blockName === "air" && actualBlockName === "air") {
                        continue;
                    }

                    if (actualBlockName !== blockName) {
                        mismatches.push({
                            level: levelData.level,
                            coordinates: [x, y, z],
                            expected: blockName,
                            actual: actualBlockName
                        });
                    } else {
                        matches.push({
                            level: levelData.level,
                            coordinates: [x, y, z],
                            expected: blockName,
                            actual: actualBlockName
                        });
                    }
                } catch (err) {
                    console.error(`Error getting block at (${x}, ${y}, ${z}):`, err);
                    return false; // Stop checking if there's an issue getting blocks
                }
            }
        }
        return {
            "mismatches": mismatches,
            "matches": matches
        };
    }

    /**
     * Takes in the blueprint, and then converts it into a set of /setblock commands for the bot to follow
     * @Returns: An object containing the setblock commands as a list of strings, and a position nearby the blueprint but not in it
     * @param blueprint
     */
    autoBuild() {
        const commands = [];
        let blueprint = this.data

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (const level of blueprint.levels) {
            console.log(level.level)
            const baseX = level.coordinates[0];
            const baseY = level.coordinates[1];
            const baseZ = level.coordinates[2];
            const placement = level.placement;

            // Update bounds
            minX = Math.min(minX, baseX);
            maxX = Math.max(maxX, baseX + placement[0].length - 1);
            minY = Math.min(minY, baseY);
            maxY = Math.max(maxY, baseY);
            minZ = Math.min(minZ, baseZ);
            maxZ = Math.max(maxZ, baseZ + placement.length - 1);

            // Loop through the 2D placement array
            for (let z = 0; z < placement.length; z++) {
                for (let x = 0; x < placement[z].length; x++) {
                    const blockType = placement[z][x];
                    if (blockType) {
                        const setblockCommand = `/setblock ${baseX + x} ${baseY} ${baseZ + z} ${blockType}`;
                        commands.push(setblockCommand);
                    }
                }
            }
        }

        // Calculate a position nearby the blueprint but not in it
        const nearbyPosition = {
            x: maxX + 5, // Move 5 blocks to the right
            y: minY,     // Stay on the lowest level of the blueprint
            z: minZ      // Stay aligned with the front of the blueprint
        };

        return { commands, nearbyPosition };
    }


    /**
     * Takes in a blueprint, and returns a set of commands to clear up the space.
     *
     */
    autoDelete() {
        console.log("auto delete called!")
        const commands = [];
        let blueprint = this.data

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (const level of blueprint.levels) {
            const baseX = level.coordinates[0];
            const baseY = level.coordinates[1];
            const baseZ = level.coordinates[2];
            const placement = level.placement;

            // Update bounds
            minX = Math.min(minX, baseX);
            maxX = Math.max(maxX, baseX + placement[0].length - 1);
            minY = Math.min(minY, baseY);
            maxY = Math.max(maxY, baseY);
            minZ = Math.min(minZ, baseZ);
            maxZ = Math.max(maxZ, baseZ + placement.length - 1);

            // Loop through the 2D placement array
            for (let z = 0; z < placement.length; z++) {
                for (let x = 0; x < placement[z].length; x++) {
                    const blockType = placement[z][x];
                    if (blockType) {
                        const setblockCommand = `/setblock ${baseX + x} ${baseY} ${baseZ + z} air`;
                        commands.push(setblockCommand);
                    }
                }
            }
        }

        // Calculate a position nearby the blueprint but not in it
        const nearbyPosition = {
            x: maxX + 5, // Move 5 blocks to the right
            y: minY,     // Stay on the lowest level of the blueprint
            z: minZ      // Stay aligned with the front of the blueprint
        };

        return { commands, nearbyPosition };
    }
}


/**
 * Systematically builds the houses by placing them next to the already existing rooms. Still uses randomness for what gets placed next.
 * @param m width of the 3D space
 * @param n height of the 3D space
 * @param p depth of the 3D space
 * @param rooms Number of rooms to attempt to generate
 * @param minRoomWidth
 * @param minRoomLength
 * @param minRoomDepth
 * @param roomVariance How much the room size will vary
 * @param wrapping material of wrapping (air, glass, etc...) -> default is air
 * @param carpetStyle 0,1,2 increasingly more complex
 * @param windowStyle 0,1,2 increasingly more complex
 * @param complexity 0,1,2,3,4 for increasingly complex materials for room generation
 * @param startCoord an array of the x,y,z coordinates to create the blueprint. default = [148,-60,-170]
 * @returns a blueprint object
 */
export function proceduralGeneration(m = 20,
                                     n = 20,
                                     p = 20,
                                     rooms = 8,
                                     minRoomWidth = 5,
                                     minRoomLength = 5,
                                     minRoomDepth = 6,
                                     roomVariance = 5,
                                     wrapping = "air",
                                     carpetStyle = 1,
                                     windowStyle = 1,
                                     complexity = 4,
                                     startCoord = [148,-60,-170]) {
    // Build 3D space
    const matrix = Array.from({length: p}, () =>
        Array.from({length: m}, () =>
            Array(n).fill('air')
        )
    );

    // todo: extrapolate into another param? then have set materials be dynamic? 
    let roomMaterials = ["stone", "terracotta", "quartz_block", "copper_block", "purpur_block"]

    if (complexity < roomMaterials.length) {
        roomMaterials = roomMaterials.slice(0, complexity + 1);
    }

    // Mark entire outer border with 'stone'
    for (let z = 0; z < p; z++) {
        for (let x = 0; x < m; x++) {
            for (let y = 0; y < n; y++) {
                if (
                    z === 0 || z === p - 1 || // Top and bottom faces
                    x === 0 || x === m - 1 || // Front and back faces
                    y === 0 || y === n - 1    // Left and right faces
                ) {
                    matrix[z][x][y] = 'stone';
                }
            }
        }
    }

    // Replace outer layer with wrap
    for (let z = 0; z < p; z++) {
        for (let x = 0; x < m; x++) {
            for (let y = 0; y < n; y++) {
                if (
                    (z === p - 1 || // Top face
                        x === 0 || x === m - 1 || // Front and back faces
                        y === 0 || y === n - 1) // Left and right faces
                ) {
                    matrix[z][x][y] = wrapping;
                }
            }
        }
    }

    let placedRooms = 0;
    let lastRoom = null;

    // Direction probabilities (e.g., 'above': 40%, 'left': 15%, etc.)
    const directionChances = [
        {direction: 'above', chance: 0.15},
        {direction: 'left', chance: 0.15},
        {direction: 'right', chance: 0.15},
        {direction: 'forward', chance: 0.15},
        {direction: 'backward', chance: 0.15},
    ];

    // Function to pick a random direction based on percentages
    function getRandomDirection() {
        const rand = Math.random();
        let cumulative = 0;

        for (const {direction, chance} of directionChances) {
            cumulative += chance;
            if (rand <= cumulative) return direction;
        }
        return directionChances[1].direction; // Fallback to the first direction
    }

    // Ensures no rooms overlap except at edges
    function isSpaceValid(newX, newY, newZ, newLength, newWidth, newDepth) {
        for (let di = 0; di < newDepth; di++) {
            for (let dj = 0; dj < newLength; dj++) {
                for (let dk = 0; dk < newWidth; dk++) {
                    const x = newX + dj;
                    const y = newY + dk;
                    const z = newZ + di;

                    // Skip checking the outermost borders of the new room (these can overlap with stone)
                    if (dj === 0 || dj === newLength - 1 ||
                        dk === 0 || dk === newWidth - 1 ||
                        di === 0 || di === newDepth - 1) {
                        continue;
                    }

                    // For non-border spaces, ensure they're air
                    if (matrix[z][x][y] !== 'air') {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    function validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material) {
        // Allow rooms to use the matrix edges (note the <= instead of <)
        if (
            newX >= 0 && newX + newLength <= m &&
            newY >= 0 && newY + newWidth <= n &&
            newZ >= 0 && newZ + newDepth <= p &&
            isSpaceValid(newX, newY, newZ, newLength, newWidth, newDepth)
        ) {
            // console.log(`Placing room at (${newX}, ${newY}, ${newZ}) with dimensions (${newLength}x${newWidth}x${newDepth})`);
            for (let di = 0; di < newDepth; di++) {
                for (let dj = 0; dj < newLength; dj++) {
                    for (let dk = 0; dk < newWidth; dk++) {
                        const x = newX + dj;
                        const y = newY + dk;
                        const z = newZ + di;

                        // If this is at a matrix border, don't modify it
                        if (z === 0) {
                            continue;
                        }
                        // if (x === 0 || x === m - 1 ||
                        //     y === 0 || y === n - 1 ||
                        //     z === 0 || z === p - 1) {
                        //     continue;
                        // }

                        // For non-border spaces, check if this is a floor that should be shared
                        //was: === 'stone'
                        if (di === 0 && matrix[z - 1][x][y] !== 'air') {
                            // Skip creating floor if there's a ceiling below
                            matrix[z][x][y] = 'air';
                        } else if (di === 0 || di === newDepth - 1 ||
                            dj === 0 || dj === newLength - 1 ||
                            dk === 0 || dk === newWidth - 1) {
                            matrix[z][x][y] = material;
                        } else {
                            matrix[z][x][y] = 'air';
                        }


                    }
                }
            }
            return true;
        }
        return false;
    }

    function addDoor(matrix, x, y, z, material) {
        matrix[z][x][y] = material;

        // Place the lower half of the door
        // matrix[z + 1][x][y] = 'dark_oak_door[half=lower, hinge=left]';

        matrix[z + 1][x][y] = 'dark_oak_door';


        // Place the upper half of the door
        // matrix[z + 2][x][y] = 'dark_oak_door[half=upper, hinge=left]';
        matrix[z + 2][x][y] = 'dark_oak_door';

    }


    // Takes in a room and randomly converts some faces to be windows
    function addWindowsAsSquares(matrix, x, y, z, newLength, newWidth, newDepth, material) {
        // Matrix dimensions
        const matrixDepth = matrix.length;
        const matrixLength = matrix[0].length;
        const matrixWidth = matrix[0][0].length;
        const windowX = Math.ceil(minRoomWidth / 2)
        const windowY = Math.ceil(minRoomLength / 2)
        const windowZ = Math.ceil(minRoomDepth / 2)

        // Helper function to check if coordinates are within bounds
        function isInBounds(z, x, y) {
            return z >= 0 && z < matrixDepth &&
                x >= 0 && x < matrixLength &&
                y >= 0 && y < matrixWidth;
        }

        // Front and back faces (z is constant)
        if (Math.random() < 0.8) {
            let centerX = x + Math.floor(newLength / 2 - windowX / 2);
            let centerY = y + Math.floor(newWidth / 2 - windowY / 2);

            for (let dx = 0; dx <= windowX; dx++) {
                for (let dy = 0; dy <= windowY; dy++) {
                    let frontZ = z;
                    let backZ = z + newDepth - 1;

                    if (isInBounds(frontZ, centerX + dx, centerY + dy) &&
                        matrix[frontZ][centerX + dx][centerY + dy] === material) {
                        matrix[frontZ][centerX + dx][centerY + dy] = 'glass';
                    }
                    if (isInBounds(backZ, centerX + dx, centerY + dy) &&
                        matrix[backZ][centerX + dx][centerY + dy] === material) {
                        matrix[backZ][centerX + dx][centerY + dy] = 'glass';
                    }
                }
            }
        }

        // Left and right faces (x is constant)
        if (Math.random() < 0.8) {
            let centerZ = z + Math.floor(newDepth / 2 - windowZ / 2);
            let centerY = y + Math.floor(newWidth / 2 - windowY / 2);

            for (let dz = 0; dz <= windowZ; dz++) {
                for (let dy = 0; dy <= windowY; dy++) {
                    let leftX = x;
                    let rightX = x + newLength - 1;

                    if (isInBounds(centerZ + dz, leftX, centerY + dy) &&
                        matrix[centerZ + dz][leftX][centerY + dy] === material) {
                        matrix[centerZ + dz][leftX][centerY + dy] = 'glass';
                    }
                    if (isInBounds(centerZ + dz, rightX, centerY + dy) &&
                        matrix[centerZ + dz][rightX][centerY + dy] === material) {
                        matrix[centerZ + dz][rightX][centerY + dy] = 'glass';
                    }
                }
            }
        }

        // Top and bottom faces (y is constant)
        if (Math.random() < 0.8) {
            let centerX = x + Math.floor(newLength / 2 - windowX / 2);
            let centerZ = z + Math.floor(newDepth / 2 - windowZ / 2);

            for (let dx = 0; dx <= windowX; dx++) {
                for (let dz = 0; dz <= windowZ; dz++) {
                    let bottomY = y;
                    let topY = y + newWidth - 1;

                    if (isInBounds(centerZ + dz, centerX + dx, bottomY) &&
                        matrix[centerZ + dz][centerX + dx][bottomY] === material) {
                        matrix[centerZ + dz][centerX + dx][bottomY] = 'glass';
                    }
                    if (isInBounds(centerZ + dz, centerX + dx, topY) &&
                        matrix[centerZ + dz][centerX + dx][topY] === material) {
                        matrix[centerZ + dz][centerX + dx][topY] = 'glass';
                    }
                }
            }
        }
    }

    function addWindowsAsPlane(matrix, x, y, z, newLength, newWidth, newDepth, material) {
        // Ensure the new dimensions are within bounds
        const maxX = matrix[0].length;
        const maxY = matrix[0][0].length;
        const maxZ = matrix.length;

        // Each face has a 30% chance of becoming a window
        if (Math.random() < 0.8) {
            for (let dx = 0; dx < newLength; dx++) {
                for (let dy = 0; dy < newWidth; dy++) {
                    let frontZ = z;
                    let backZ = z + newDepth - 1;

                    // Check bounds before modifying the matrix
                    if (frontZ >= 0 && frontZ < maxZ && x + dx >= 0 && x + dx < maxX && y + dy >= 0 && y + dy < maxY) {
                        if (matrix[frontZ][x + dx][y + dy] === material) {
                            matrix[frontZ][x + dx][y + dy] = 'glass';
                        }
                    }
                    if (backZ >= 0 && backZ < maxZ && x + dx >= 0 && x + dx < maxX && y + dy >= 0 && y + dy < maxY) {
                        if (matrix[backZ][x + dx][y + dy] === material) {
                            matrix[backZ][x + dx][y + dy] = 'glass';
                        }
                    }
                }
            }
        }

        if (Math.random() < 0.8) {
            for (let dz = 0; dz < newDepth; dz++) {
                for (let dy = 0; dy < newWidth; dy++) {
                    let leftX = x;
                    let rightX = x + newLength - 1;

                    // Check bounds before modifying the matrix
                    if (leftX >= 0 && leftX < maxX && z + dz >= 0 && z + dz < maxZ && y + dy >= 0 && y + dy < maxY) {
                        if (matrix[z + dz][leftX][y + dy] === material) {
                            matrix[z + dz][leftX][y + dy] = 'glass';
                        }
                    }
                    if (rightX >= 0 && rightX < maxX && z + dz >= 0 && z + dz < maxZ && y + dy >= 0 && y + dy < maxY) {
                        if (matrix[z + dz][rightX][y + dy] === material) {
                            matrix[z + dz][rightX][y + dy] = 'glass';
                        }
                    }
                }
            }
        }
    }


    //still a little buggy
    function addStairs(matrix, x, y, z, length, width, material) {
        let currentZ = z;
        let currentX = x + 1;
        let currentY = y + 1;
        let direction = 0;
        let stepCount = 0;
        const maxSteps = length * width; // Safety limit

        while (currentZ >= 0 && currentX < x + length - 1 && currentY < y + width - 1 && stepCount < maxSteps) {
            // Place stair block
            matrix[currentZ][currentX][currentY] = material || 'stone';

            // Clear 3 blocks above for headroom
            for (let i = 1; i <= 3; i++) {
                if (currentZ + i < matrix.length) {
                    matrix[currentZ + i][currentX][currentY] = 'air';
                }
            }

            // Move to next position based on direction
            if (direction === 0) {
                currentX++;
                if (currentX >= x + length - 1) {
                    currentX = x + length - 2;
                    direction = 1;
                } else {
                    currentZ--;
                }
            } else {
                currentY++;
                if (currentY >= y + width - 1) {
                    currentY = y + width - 2;
                    direction = 0;
                } else {
                    currentZ--;
                }
            }

            stepCount++;
        }
    }

    function addCarpet(probability, matrix, newX, newY, newZ, newLength, newWidth, material) {
        let colors = ["blue", "cyan", "light_blue", "lime"];

        // Iterate through the dimensions of the room
        for (let dx = 1; dx < newLength - 1; dx++) {
            for (let dy = 1; dy < newWidth - 1; dy++) {
                let x = newX + dx;
                let y = newY + dy;
                let z = newZ; // Start at floor level

                // Check if there is floor (not air)
                if (matrix[z][x][y] === material) {
                    // Consider a random probability of adding a carpet
                    if (Math.random() < probability) {
                        // Choose a random color for the carpet
                        let randomColor = colors[Math.floor(Math.random() * colors.length)];
                        // Add carpet one z position above the floor with a random color
                        matrix[z + 1][x][y] = `${randomColor}_carpet`;
                    }
                }
            }
        }
    }

    function addLadder(matrix, x, y, z) {
        let currentZ = z + 1;

        // turn the floor into air where person would go up
        matrix[currentZ][x + 1][y] = 'air';

        // Build the first 3 ladder segments from floor level downwards
        for (let i = 0; i < 3; i++) {
            // Place stone block behind ladder
            matrix[currentZ][x - 1][y] = 'stone';
            // Place ladder
            matrix[currentZ][x][y] = 'ladder[facing=north]';
            currentZ -= 1;
        }

        // Continue building ladder downwards until a floor is hit or we reach the bottom
        while (currentZ >= 0 && matrix[currentZ][x][y] === 'air') {
            // Place stone block behind ladder
            matrix[currentZ][x - 1][y] = 'stone';
            // Place ladder
            matrix[currentZ][x][y] = 'ladder[facing=north]';

            // Move down
            currentZ--;
        }
    }


    function embellishments(carpet, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material) {


        switch (windowStyle) {
            case 0:
                break;
            case 1:
                addWindowsAsSquares(matrix, newZ, newY, newZ, newLength, newWidth, newDepth, material)
                break;
            case 2:
                addWindowsAsPlane(matrix, newZ, newY, newZ, newLength, newWidth, newDepth, material)
        }


        switch (carpet) {
            case 0:
                break;
            case 1:
                addCarpet(0.3, matrix, newX, newY, newZ, newLength, newWidth, material);
                break;
            case 2:
                addCarpet(0.7, matrix, newX, newY, newZ, newLength, newWidth, material)
                break;
        }


    }


    // Places rooms until we can't, or we place all
    // attempts random configurations of rooms in random directions.
    while (placedRooms < rooms) {
        let roomPlaced = false;

        for (let attempt = 0; attempt < 150; attempt++) {

            const material = roomMaterials[Math.floor(Math.random() * roomMaterials.length)];


            // dimensions of room
            const newLength = Math.max(minRoomLength, Math.floor(Math.random() * roomVariance) + minRoomLength);
            const newWidth = Math.max(minRoomWidth, Math.floor(Math.random() * roomVariance) + minRoomWidth);
            const newDepth = Math.max(minRoomDepth, Math.floor(Math.random() * Math.floor(roomVariance / 2)) + minRoomDepth);
            let newX, newY, newZ;

            // first room is special
            if (placedRooms === 0) {
                // First room placement
                newX = Math.floor(Math.random() * (m - newLength - 1)) + 1;
                newY = Math.floor(Math.random() * (n - newWidth - 1)) + 1;
                newZ = 0; // Ground floor

                if (validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material)) {
                    lastRoom = {x: newX, y: newY, z: newZ, length: newLength, width: newWidth, depth: newDepth};
                    roomPlaced = true;
                    placedRooms++;

                    // Add doors to all four sides
                    // Left side
                    addDoor(matrix, newX, newY + Math.floor(newWidth / 2), newZ, material);
                    // Right side
                    addDoor(matrix, newX + newLength - 1, newY + Math.floor(newWidth / 2), newZ, material);
                    // Front side
                    addDoor(matrix, newX + Math.floor(newLength / 2), newY, newZ, material);
                    // Back side
                    addDoor(matrix, newX + Math.floor(newLength / 2), newY + newWidth - 1, newZ, material);

                    addCarpet(0.7, matrix, newX, newY, newZ, newLength, newWidth)
                }

                break;
            } else {
                const direction = getRandomDirection();

                switch (direction) {
                    case 'above':
                        newX = lastRoom.x;
                        newY = lastRoom.y;
                        newZ = lastRoom.z + lastRoom.depth - 1;
                        if (validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material)) {

                            embellishments(carpetStyle, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material)

                            // addLadder(matrix, lastRoom.x + Math.floor(lastRoom.length / 2),
                            //     lastRoom.y + Math.floor(lastRoom.width / 2),
                            //     newZ); // Adding the ladder

                            addStairs(matrix, newX, newY, newZ, newLength, newWidth, material)


                            lastRoom = {x: newX, y: newY, z: newZ, length: newLength, width: newWidth, depth: newDepth};
                            roomPlaced = true;
                            placedRooms++;
                            break;
                        }
                        break;

                    case 'left':
                        newX = lastRoom.x - newLength + 1;
                        newY = lastRoom.y;
                        newZ = lastRoom.z;
                        if (validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material)) {


                            embellishments(carpetStyle, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material)


                            addDoor(matrix, lastRoom.x, lastRoom.y + Math.floor(lastRoom.width / 2), lastRoom.z, material);


                            lastRoom = {x: newX, y: newY, z: newZ, length: newLength, width: newWidth, depth: newDepth};
                            roomPlaced = true;
                            placedRooms++;
                            break;
                        }
                        break;

                    case 'right':
                        newX = lastRoom.x + lastRoom.length - 1;
                        newY = lastRoom.y;
                        newZ = lastRoom.z;
                        if (validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material)) {

                            embellishments(carpetStyle, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material)


                            addDoor(matrix, lastRoom.x + lastRoom.length - 1,
                                lastRoom.y + Math.floor(lastRoom.width / 2),
                                lastRoom.z, material);


                            lastRoom = {x: newX, y: newY, z: newZ, length: newLength, width: newWidth, depth: newDepth};
                            roomPlaced = true;
                            placedRooms++;
                            break;
                        }
                        break;

                    case 'forward':
                        newX = lastRoom.x;
                        newY = lastRoom.y + lastRoom.width - 1;
                        newZ = lastRoom.z;
                        if (validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material)) {

                            embellishments(carpetStyle, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material)


                            addDoor(matrix, lastRoom.x + Math.floor(lastRoom.length / 2),
                                lastRoom.y + lastRoom.width - 1,
                                lastRoom.z, material);


                            lastRoom = {x: newX, y: newY, z: newZ, length: newLength, width: newWidth, depth: newDepth};
                            roomPlaced = true;
                            placedRooms++;
                            break;
                        }
                        break;

                    case 'backward':
                        newX = lastRoom.x;
                        newY = lastRoom.y - newWidth + 1;
                        newZ = lastRoom.z;
                        if (validateAndBuildBorder(matrix, newX, newY, newZ, newLength, newWidth, newDepth, m, n, p, material)) {

                            embellishments(carpetStyle, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material)


                            addDoor(matrix, lastRoom.x + Math.floor(lastRoom.length / 2),
                                lastRoom.y,
                                lastRoom.z, material);


                            lastRoom = {x: newX, y: newY, z: newZ, length: newLength, width: newWidth, depth: newDepth};
                            roomPlaced = true;
                            placedRooms++;
                            break;
                        }
                        break;
                }

                if (roomPlaced) {
                    break;
                }
            }
        }

        if (!roomPlaced) {
            console.warn(`Could not place room ${placedRooms + 1}`);
            break;
        }
    }

    // uncomment to visualize blueprint output
    // printMatrix(matrix)

    return matrixToBlueprint(matrix, startCoord)
}




/**
 * for cutesy output
 * @param matrix
 */
function printMatrix(matrix) {
    matrix.forEach((layer, layerIndex) => {
        console.log(`Layer ${layerIndex}:`);
        layer.forEach(row => {
            console.log(
                row.map(cell => {
                    switch (cell) {
                        case 'stone': return '█';  // Wall
                        case 'air': return '.';    // Open space
                        case 'dark_oak_door[half=upper, hinge=left]': return 'D';
                        case 'dark_oak_door[half=lower, hinge=left]': return 'D';
                        case 'oak_stairs[facing=north]': return 'S';  // Stairs
                        case 'oak_stairs[facing=east]': return 'S';  // Stairs
                        case 'oak_stairs[facing=south]': return 'S';  // Stairs
                        case 'oak_stairs[facing=west]': return 'S';  // Stairs
                        case 'glass': return 'W'


                        default: return '?';       // Unknown or unmarked space
                    }
                }).join(' ')
            );
        });
        console.log('---');
    });
}

/**
 * Converts a 3D matrix into a Minecraft blueprint format
 * @param {Array<Array<Array<string>>>} matrix - 3D matrix of block types
 * @param {number[]} startCoord - Starting coordinates [x, y, z]
 * @returns {Object} a Blueprint object in Minecraft format
 */
function matrixToBlueprint(matrix, startCoord) {
    // Validate inputs
    if (!Array.isArray(matrix) || !Array.isArray(startCoord) || startCoord.length !== 3) {
        console.log(matrix)
        throw new Error('Invalid input format');
    }

    const [startX, startY, startZ] = startCoord;


    // CONSIDER: using blueprint class here?
    return {
        levels: matrix.map((level, levelIndex) => ({
            level: levelIndex,
            coordinates: [
                startX,
                startY + levelIndex,
                startZ
            ],
            placement: level.map(row =>
                // Ensure each block is a string, default to 'air' if undefined
                row.map(block => block?.toString() || 'air')
            )
        }))
    };
}

async function getBlockName(bot, coordinate) {
    const blockAtLocation = bot.blockAt(new Vec3(coordinate.x, coordinate.y, coordinate.z));
    return blockAtLocation ? bot.registry.blocks[blockAtLocation.type].name : "air";
}

/**
 * Converts a world location to a blueprint. takes some time to ensure that the chunks are loaded before conversion.
 * @param startCoord - [x,y,z] that signifies the start of the blueprint
 * @param y_amount - how many spaces you want to register from the start coordinate in the y dimension
 * @param x_amount - how many spaces in the x direction on minecraft
 * @param z_amount - how many spaces from the start coordinate in the z direction in minecraft
 * @param bot - the mineflayer agent (ex. andy)
 * @returns - a Blueprint object of the converted blueprint
 */
export async function worldToBlueprint(startCoord, y_amount, x_amount, z_amount, bot) {
    await bot.waitForChunksToLoad();

    const materials = {};

    const levels = [];
    for (let y = 0; y < y_amount; y++) {
        const placement = [];
        const coordinates = [startCoord.x, startCoord.y + y, startCoord.z];
        for (let z = 0; z < z_amount; z++) {
            const row = [];
            for (let x = 0; x < x_amount; x++) {
                const worldCoord = {
                    x: startCoord.x + x,
                    y: startCoord.y + y,
                    z: startCoord.z + z
                };
                await bot.waitForChunksToLoad(worldCoord);
                const blockName = await getBlockName(bot, worldCoord);
                row.push(blockName);
                if (blockName !== 'air') {
                    materials[blockName] = (materials[blockName] || 0) + 1;
                }
            }
            placement.push(row);
        }
        levels.push({
            level: y,
            coordinates: coordinates,
            placement: placement
        })
    }
    console.log(levels);
    const blueprint_data = {
        materials: materials,
        levels: levels
    }
    return blueprint_data
}

export function blueprintToTask(blueprint_data, num_agents) {
    let initialInventory = {}
    for (let j = 0; j < num_agents; j++) {
        initialInventory[JSON.stringify(j)] = {"diamond_pickaxe": 1, "diamond_axe": 1, "diamond_shovel": 1};
    }

    let give_agent = 0;
    console.log("materials", blueprint_data.materials)
    for (const key of Object.keys(blueprint_data.materials)) {
        initialInventory[JSON.stringify(give_agent)][key] = blueprint_data.materials[key];
        give_agent = (give_agent + 1) % num_agents;
    }

    const task = {
        type: "construction",
        goal: "Make a structure with the blueprint below",
        conversation: "Let's share materials and make a structure with the blueprint",
        agent_count: num_agents,
        blueprint: blueprint_data,
        initial_inventory: initialInventory,
    };
    return task;
}

// testing code

// let blueprint = proceduralGeneration(20,10,20)
// const b = new Blueprint(blueprint)
// const result = b.autoBuild();
// const commands = result.commands;
// const nearbyPosition = result.nearbyPosition;
//
//
// import {initBot} from "../../utils/mcdata.js";
// let bot = initBot("andy");


// example usage of world->blueprint function

// bot.once('spawn', async () => {
//     console.log("nearby position", nearbyPosition);
//     bot.chat(`/tp @andy ${nearbyPosition.x} ${nearbyPosition.y} ${nearbyPosition.z}`);
//     for (const command of commands) {
//         bot.chat(command);
//     }
//     const startCoord = {
//         x: 148,
//         y: -60,
//         z: -170
//     };
//     // [148,-60,-170] is default start for procedural generation
//
//     const worldOutput = await worldToBlueprint(startCoord, 20,10,20, bot)
// });