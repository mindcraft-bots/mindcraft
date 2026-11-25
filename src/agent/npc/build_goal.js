import { Vec3 } from 'vec3';
import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { blockSatisfied, getTypeOfGeneric, rotateXZ } from './utils.js';


export class BuildGoal {
    constructor(agent) {
        this.agent = agent;
    }

    async wrapSkill(func) {
        if (!this.agent.isIdle())
            return false;
        await new Promise(resolve => setTimeout(resolve, 50)); // one game tick per block
        let res = await this.agent.actions.runAction('BuildGoal', func);
        return !res.interrupted;
    }

    async executeNext(goal, position=null, orientation=null) {
        let sizex = goal.blocks[0][0].length;
        let sizez = goal.blocks[0].length;
        let sizey = goal.blocks.length;
        if (!position) {
            for (let x = 0; x < sizex - 1; x++) {
                position = world.getNearestFreeSpace(this.agent.bot, sizex - x, 16);
                if (position) break;
            }
        }
        if (orientation === null) {
            orientation = Math.floor(Math.random() * 4);
        }

        let inventory = world.getInventoryCounts(this.agent.bot);
        let missing = {};
        let acted = false;
        for (let y = goal.offset; y < sizey+goal.offset; y++) {
            for (let z = 0; z < sizez; z++) {
                for (let x = 0; x < sizex; x++) {

                    let [rx, rz] = rotateXZ(x, z, orientation, sizex, sizez);
                    let ry = y - goal.offset;
                    let block_name = goal.blocks[ry][rz][rx];
                    if (block_name === null || block_name === '') continue;

                    let world_pos = new Vec3(position.x + x, position.y + y, position.z + z);
                    let current_block = this.agent.bot.blockAt(world_pos);

                    let res = null;
                    if (current_block !== null && !blockSatisfied(block_name, current_block)) {
                        acted = true;

                        if (current_block.name !== 'air') {
                            res = await this.wrapSkill(async () => {
                                await skills.breakBlockAt(this.agent.bot, world_pos.x, world_pos.y, world_pos.z);
                            });
                            if (!res) return {missing: missing, acted: acted, position: position, orientation: orientation};
                        }

                        if (block_name !== 'air') {
                            let block_typed = getTypeOfGeneric(this.agent.bot, block_name);
                            if (inventory[block_typed] > 0) {
                                res = await this.wrapSkill(async () => {
                                    await skills.placeBlock(this.agent.bot, block_typed, world_pos.x, world_pos.y, world_pos.z);
                                });
                                if (!res) return {missing: missing, acted: acted, position: position, orientation: orientation};
                            } else {
                                if (missing[block_typed] === undefined)
                                    missing[block_typed] = 0;
                                missing[block_typed]++;
                            }
                        }
                    }
                }
            }
        }
        return {missing: missing, acted: acted, position: position, orientation: orientation};
    }

}