import argparse
import json
import shutil
import subprocess
import time
from datetime import datetime
import re
import sys
import os
import time
import filecmp
import json
import glob
import socket

import boto3

BLOCKED_ACTIONS_COOKING = [
    '!activate', '!attackPlayer', '!checkBlueprint', '!checkBlueprintLevel',
    '!clearChat', '!clearFurnace', '!consume', '!craftable', '!discard',
    '!endGoal', '!entities', '!equip', '!followPlayer', '!getBlueprint', '!getBlueprintLevel',
    '!goToBed', '!help', '!modes', '!moveAway', '!newAction', '!placeHere', '!putInChest',
    '!restart', '!setMode', '!stay', '!stfu', '!stop'
]
BLOCKED_ACTIONS_CRAFTING = [
    '!activate', '!attack', '!attackPlayer', '!checkBlueprint', '!checkBlueprintLevel',
    '!clearChat', '!clearFurnace', '!consume', '!craftable', '!discard', '!endConversation',
    '!endGoal', '!entities', '!followPlayer', '!getBlueprint', '!getBlueprintLevel',
    '!goToBed', '!help', '!modes', '!newAction', '!putInChest', '!restart',
    '!searchForEntity', '!setMode', '!stay', '!stfu', '!stop', '!takeFromChest',
    '!viewChest'
]
BLOCKED_ACTIONS_CONSTRUCTION = [
    '!activate', '!attackPlayer', '!clearChat', '!clearFurnace', '!collectBlocks',
    '!consume', '!craftable', '!discard', '!endConversation', '!endGoal', '!entities',
    '!equip', '!followPlayer', '!getBlueprint', '!getBlueprintLevel', '!goToBed',
    '!help', '!modes', '!moveAway', '!newAction', '!placeHere', '!putInChest',
    '!restart', '!searchForBlock', '!searchForEntity', '!setMode', '!stay', '!stfu',
    '!stop', '!takeFromChest', '!viewChest', '!craftRecipe', '!smeltItem'
]

def analyze_json_file(file_path):
    """
    Analyzes a single JSON file to extract the task outcome.

    Args:
        file_path (str): Path to the JSON file.

    Returns:
        str or None: The task outcome string if found, otherwise None.
    """
    try:
        with open(file_path, 'r') as f:
            data = json.load(f)
            if "turns" in data:
                for turn in data["turns"]:
                    if turn.get("role") == "system" and "content" in turn:
                        if isinstance(turn["content"], str) and "Task ended with score : " in turn["content"]:
                            if "Task ended with score : 1" in turn["content"]:
                                return 1
                            elif "Task ended with score : 0" in turn["content"]:
                                return 0
                            else:
                                score = float(turn["content"].split(":")[-1].strip())
                                return score
                            
                            
        return None
    except FileNotFoundError:
        print(f"Error: File not found: {file_path}")
        return None
    except json.JSONDecodeError:
        print(f"Error: Invalid JSON format in: {file_path}")
        return None
    except Exception as e:
        print(f"An unexpected error occurred while processing {file_path}: {e}")
        return None
    
def extract_result(folder_path):
    folder_name = os.path.basename(folder_path)
    json_files = glob.glob(os.path.join(folder_path, "*.json"))
    # assert len(json_files) == 2, f"Expected 2 json files in {folder_name}, found {len(json_files)}"

    if not json_files:
        return None
    else: 
        score = None
        curr_score = 0
        for json_file in json_files:
            score = analyze_json_file(json_file)
            if score is not None:
                max_score = max(score, curr_score)
                curr_score = max_score

        return curr_score
    
def aggregate_results(local_folders):
    """
    Aggregates the analysis results for each folder.

    Args:
        local_folders (list): List of local folder paths containing the JSON files.

    Returns:
        dict: A dictionary where keys are folder names and values are the aggregated outcomes.
    """
    aggregated_data = {}

    total = 0
    successful = 0
    successful_tasks = []

    task_type = local_folders[0].split("/")[-2]
    if "cooking" in task_type:
        task_type = "cooking"
    elif "techtree" in task_type:
        task_type = "techtree"
    elif "construction" in task_type:
        task_type = "construction"

    for folder_path in local_folders:
        folder_name = os.path.basename(folder_path)

        try: 
            result = extract_result(folder_path)
            
            if result == 1:
                successful_tasks.append(folder_name)
            if result is not None:
                total += 1
                successful += result
        except Exception as e:
            print(f"Error processing {folder_name}: {e}")

    successful_tasks.sort()

    if task_type == "construction":
        successful = successful / total
    
    return {
        "total": total,
        "successful": successful,
    }

def check_folder_results(folder_path):
    """
    Evaluate all JSON files in a folder and its subfolders and calculate success metrics.
    
    Args:
        folder_path (str): Path to the folder containing JSON log files.
        
    Returns:
        dict: A dictionary with success metrics.
    """
    print(f"Checking results in folder: {folder_path}")
    
    # Check if the folder exists
    if not os.path.exists(folder_path):
        print(f"Error: Folder not found: {folder_path}")
        return None
    
    # Find all subfolders (task IDs) in the given folder
    if os.path.isdir(folder_path):
        subfolders = [f for f in glob.glob(os.path.join(folder_path, "*")) if os.path.isdir(f)]
        if subfolders:
            # If there are subfolders, evaluate each subfolder
            print(f"Found {len(subfolders)} subfolders to evaluate")
            results = aggregate_results(subfolders)
        else:
            # If no subfolders, treat the folder itself as a results folder
            print("No subfolders found, evaluating the folder itself")
            results = aggregate_results([folder_path])
            
        # Calculate success rate
        if results["total"] > 0:
            results["success_rate"] = results["successful"] / results["total"]
        else:
            results["success_rate"] = 0.0
            
        # Print summary
        print("\n=== Evaluation Results ===")
        print("\nEvaluating Tasks!")
        print(f"Results so far: {results['total']}")

        if "construction" not in folder_path:
            print(f"Successful tasks: {results['successful']}")

        if "construction" not in folder_path:
            print(f"Success rate: {results['success_rate']:.2f}")
        else:
            print(f"Success rate: {results['successful']:.2f}")
        
        return results
    else:
        print(f"Error: {folder_path} is not a directory")
        return None

def read_settings(file_path):
    """Read and parse the settings.js file to get agent profiles."""
    with open(file_path, 'r', encoding='utf-8') as file:
        content = file.read()

    # Remove `export default` and trailing commas
    content = re.sub(r'export\s+default', '', content)
    content = re.sub(r',\s*(?=[}\]])', '', content)

    # Remove JavaScript comments
    content = re.sub(r'//.*', '', content)

    # Remove trailing commas (e.g., before } or ])
    content = re.sub(r',\s*(?=[}\]])', '', content)

    # Strip leading and trailing whitespace
    content = content.strip()

    json_data = json.loads(content)

    profiles = json_data['profiles']

    ## profiles is a list of strings like "./andy.json" and "./bob.json"

    agent_names = [profile.split('/')[-1].split('.')[0] for profile in profiles]
    return agent_names 

def update_keys_json():
    """Update the settings_llm_providers.json file with the specified key-value pair."""
    with open("settings_llm_providers.example.json", 'r', encoding='utf-8') as file:
        content = file.read()
    data = json.loads(content)

    # Update keys with environment variables
    for key in data.keys():
        env_value = os.getenv(key)  # Fetch from environment variables
        if env_value:  # If the variable exists, update it
            data[key] = env_value

    with open("settings_llm_providers.json", 'w', encoding='utf-8') as file:
        json.dump(data, file, indent=4)

def set_environment_variable_tmux_session(session_name, key, value):
    """Set an environment variable for the current process."""
    subprocess.run(["tmux", "send-keys", "-t", session_name, f"export {key}={value}", "C-m"])

def launch_parallel_experiments(task_path, 
                                num_exp, 
                                exp_name, 
                                num_agents=2, 
                                model="gpt-4o-mini",
                                api="openai",
                                num_parallel=1,
                                s3=False, 
                                bucket_name="mindcraft-experiments", 
                                template_profile="profiles/tasks/collab_profile.json", 
                                insecure_coding=False, 
                                url="http://127.0.0.1:8000/v1", 
                                max_messages=15,
                                num_examples=2, 
                                no_pruning=False,
                                block_conversation=False, 
                                run_in_tmux=True):
    
    with open(task_path, 'r', encoding='utf-8') as file:
        content = file.read()
    json_data = json.loads(content)

    task_ids = json_data.keys()

    task_type = json_data[list(task_ids)[0]]["type"]
    # split the task_ids into num_parallel groups
    task_ids = list(task_ids)
    task_ids_split = [task_ids[i::num_parallel] for i in range(num_parallel)]

    if task_type == "cooking":
        world_name = "Superflat"
    elif task_type == "techtree":
        world_name = "Forest"
    elif task_type == "construction":
        world_name = "Superflat"

    if run_in_tmux:
        servers = create_server_files("./tasks/server_data/", num_parallel, world_name=world_name)
    else:
        servers = [(f"./tasks/server_data_{i}/", 55916 + i) for i in range(num_parallel)]
    date_time = datetime.now().strftime("%m-%d_%H-%M")
    experiments_folder = f"experiments/{exp_name}_{date_time}"
    exp_name = f"{exp_name}_{date_time}"

    split_task_path = task_path.split("/")
    if len(split_task_path) > 1:
        task_path_name = split_task_path[-2]
    else:
        task_path_name = "tasks"

    s3_path = f"{bucket_name}/{task_type}/{model}/{task_path_name}/{exp_name}"

    # start wandb
    os.makedirs(experiments_folder, exist_ok=True)
    for i, server in enumerate(servers):
        launch_server_experiment(task_path, 
                                 task_ids_split[i], 
                                 num_exp, 
                                 server, 
                                 experiments_folder, 
                                 exp_name, 
                                 s3=s3, 
                                 bucket_name=bucket_name, 
                                 template_profile=template_profile, 
                                 model=model, 
                                 api=api, 
                                 insecure_coding=insecure_coding,
                                 num_agents=num_agents, 
                                 url=url, 
                                 task_type=task_type, 
                                 s3_path=s3_path, 
                                 max_messages=max_messages,
                                 num_examples=num_examples, 
                                 no_pruning=no_pruning,
                                 block_conversation=block_conversation, 
                                 run_in_tmux=run_in_tmux)
        time.sleep(5)
    
    total_num_tasks = len(task_ids)
    total_num_experiments = total_num_tasks * num_exp
    total_run = 0
    while total_run < total_num_experiments:
        results = aggregate_results([f"{experiments_folder}/{task_id}" for task_id in task_ids])
        total_run = results["total"]
        print(f"Total tasks run: {total_run}/{total_num_experiments}")
        print(results)
        results["exp_name"] = exp_name
        results["template_profile"] = template_profile
        results["model"] = model
        results["api"] = api
        results["num_agents"] = num_agents
        results["task_path"] = task_path
        results["task_type"] = task_type
        results["max_messages"] = max_messages
        results["num_examples"] = num_examples
        with open(f"{experiments_folder}/results.txt", "w") as file:
            file.write(str(results))
        if s3: 
            cmd = f"aws s3 cp {experiments_folder}/results.txt s3://{s3_path}/results.txt"
            print(cmd)
            subprocess.run(cmd.split())
        
        time.sleep(60)

def launch_server_experiment(task_path, 
                             task_ids, 
                             num_exp, 
                             server, 
                             experiments_folder,
                             exp_name="exp", 
                             num_agents=2, 
                             model="gpt-4o",
                             api="openai", 
                             s3=False, 
                             bucket_name="mindcraft-experiments", 
                             template_profile="profiles/tasks/collab_profile.json", 
                             insecure_coding=False, 
                             url="http://127.0.0.1:8000/v1", 
                             task_type="techtree", 
                             s3_path="", 
                             max_messages=15, 
                             num_examples=2, 
                             no_pruning=False,
                             block_conversation=False, 
                             run_in_tmux=True):
    
    """
    Launch a Minecraft server and run experiments on it.
    @param task_path: Path to the task file
    @param task_ids: IDs of the tasks to run
    @param num_exp: Number of experiments to run
    @param server: Tuple containing server path and port
    @param experiments_folder: Folder to store experiment results
    @param exp_name: Name of the experiment for wandb dataset
    @param num_agents: Number of agents to run
    @param model: Model to use for the agents
    @param s3: Boolean flag to enable S3 upload
    @param bucket_name: Name of the S3 bucket
    """
    server_path, server_port = server
    edit_file(os.path.join(server_path, "server.properties"), {"server-port": server_port})
    mindserver_port = server_port - 55916 + 8080
    
    # set up server and agents 
    session_name = str(server_port - 55916)
    if num_agents == 1: 
        agent_names = [f"Andy_{session_name}"]
        models = [model]
        apis = [api]
    elif num_agents == 2:
        agent_names = [f"Andy_{session_name}", f"Jill_{session_name}"]
        models = [model] * 2
        apis = [api] * 2
    else:
        # Lets use an ordered list of 10 human names.
        human_names = ["Andy", "Jill", "Bob", "Sally", "Mike", "Laura", "John", "Emma", "Tom", "Kate"]
        agent_names = []
        for i in range(num_agents):
            name = human_names[i % len(human_names)]
            agent_names.append(f"{name}_{session_name}")
        models = [model] * num_agents
        apis = [api] * num_agents
        
    make_profiles(agent_names, models, apis, template_profile=template_profile, url=url)

    agent_profiles = [f"./{agent}.json" for agent in agent_names]

    if num_agents == 1:
        agent_profiles_str = f"'[\"{agent_profiles[0]}\"]'"
    elif num_agents == 2:
        agent_profiles_str = f"'[\"{agent_profiles[0]}\", \"{agent_profiles[1]}\"]'"
    else: 
        agent_profiles_str = "'["
        for agent in agent_profiles[:-1]:
            agent_profiles_str += f'\"{agent}\", '
        agent_profiles_str += f"\"{agent_profiles[-1]}\"]'"
    print(agent_profiles_str)
    if run_in_tmux:
        print("run in tmux is true")
        launch_world(server_path, session_name="server_" + session_name, agent_names=agent_names, port=server_port)

        subprocess.run(['tmux', 'new-session', '-d', '-s', session_name], check=True) 
    # set environment variables
    if run_in_tmux:
        set_environment_variable_tmux_session(session_name, "MINECRAFT_PORT", server_port)
        set_environment_variable_tmux_session(session_name, "MINDSERVER_PORT", mindserver_port)
        set_environment_variable_tmux_session(session_name, "PROFILES", agent_profiles_str)
        set_environment_variable_tmux_session(session_name, "MAX_MESSAGES", str(max_messages))
        set_environment_variable_tmux_session(session_name, "NUM_EXAMPLES", str(num_examples))
        set_environment_variable_tmux_session(session_name, "LOG_ALL", "true")
        if insecure_coding:
            set_environment_variable_tmux_session(session_name, "INSECURE_CODING", "true")
        make_ops(agent_names, session_name)
    else: 
        agent_profiles_str = "["
        for agent in agent_profiles[:-1]:
            agent_profiles_str += f"\"{agent}\", " 
        agent_profiles_str += f"\"{agent_profiles[-1]}\"]"
        # print(agent_profiles_str)
        os.environ["PROFILES"] = agent_profiles_str
        os.environ["MAX_MESSAGES"] = str(max_messages)
        os.environ["NUM_EXAMPLES"] = str(num_examples)
        os.environ["LOG_ALL"] = "true"
    
    run_script(task_path, 
               task_ids, 
               num_exp, 
               experiments_folder, 
               agent_names, 
               server_path, 
               s3=s3, 
               s3_path=s3_path, 
               session_name=session_name, 
               run_in_tmux=run_in_tmux)

def run_script(task_path, 
               task_ids, 
               num_exp,
               experiments_folder, 
               agent_names,
               server_path,
               s3=False,
               s3_path="mindcraft-experiments",
               session_name="0",
               run_in_tmux=True,):
    script_content = ""
    for task_id in task_ids:
        # Create a separate folder for each task_id
        task_folder = os.path.join(experiments_folder, str(task_id))
        os.makedirs(task_folder, exist_ok=True)
        assert os.path.exists(task_folder), f"Directory {task_folder} was not created"
        print(f"Created directory: {task_folder}")
        
        cmd = f"node main.js --task_path \'{task_path}\' --task_id {task_id}"
        cp_cmd = f"cp {agent_names[0]}.json {server_path}bots/{agent_names[0]}/profile.json"
        for _ in range(num_exp):
            script_content += f"{cmd}\n"
            script_content += "sleep 2\n"
            for agent in agent_names:
                agent_file_path = os.path.join(task_folder, f"{agent}_{_}.json")
                script_content += f"echo 'Saving to {agent_file_path}'\n"
                cp_cmd = f"cp bots/{agent}/memory.json {agent_file_path}"
                script_content += f"echo '{cp_cmd}'\n"
                script_content += f"{cp_cmd}\n"
                script_content += "sleep 1\n"
                if s3:
                    s3_cmd = f"aws s3 cp {agent_file_path} s3://{s3_path}/{task_id}/{agent}_{_}.json"
                    script_content += f"echo 'Uploading {agent_file_path} to S3'\n"
                    script_content += f"echo '{s3_cmd}'\n"
                    script_content += f"{s3_cmd}\n"
                    script_content += "sleep 1\n"
        script_content += f"sleep 10\n"
        if s3:
            for agent in agent_names:
                script_content += f"aws s3 cp bots/{agent} s3://{s3_path}/bots/{agent} --recursive\n"

    # Create a temporary shell script file
    script_file = f"./tmp/experiment_script_{session_name}.sh"
    make_script_file_and_run(script_content, script_file, session_name=session_name, run_in_tmux=run_in_tmux)


def make_ops(agent_names, session_name):
    """Make the agents operators in the Minecraft world."""
    print('Making agents operators...')

    cmd = f"node main.js --task_path tasks/example_tasks.json --task_id debug_{len(agent_names)}_agent_timeout"

    subprocess.run(["tmux", "send-keys", "-t", session_name, cmd, "C-m"])

    time.sleep(30)

    subprocess.run(["tmux", "send-keys", "-t", "server_" + session_name, f"/op @a", "C-m"])

    agents_op = check_agent_ops(agent_names, ops_file=f"./tasks/server_data_{session_name}/ops.json")
    if agents_op:
        print("Agents are operators! You are good to go :D")
    else: 
        print("Agents are not operators! We will need to try making them operators again!")
        make_ops(agent_names, session_name)

def check_agent_ops(agent_names, ops_file="ops.json"):
    with open(ops_file, "r") as f:
        ops_data = json.load(f)
    
    ops_names = [op["name"] for op in ops_data]
    
    for agent in agent_names:
        if agent not in ops_names:
            return False 
    return True

def make_script_file_and_run(script_content, 
                             file_name, 
                             session_name="0",
                             run_in_tmux=True):
    script_dir = os.path.dirname(file_name)
    os.makedirs(script_dir, exist_ok=True)
    assert os.path.exists(script_dir), f"Script directory {script_dir} was not created"
    print(f"Created script directory: {script_dir}")

    # Call the function before writing the script file
    with open(file_name, 'w') as f:
        f.write(script_content)
    assert os.path.exists(file_name), f"Script file {file_name} was not created"

    script_file_run = "bash " + file_name

    # Execute the shell script using subprocess
    if run_in_tmux:
        subprocess.run(["tmux", "send-keys", "-t", session_name, script_file_run, "C-m"])
    else:
        subprocess.run(script_file_run.split())

def make_profiles(agent_names, models, apis, template_profile="profiles/collab_profile.json", url="http://127.0.0.1:8000/v1"):
    assert len(agent_names) == len(models)

    with open(template_profile, 'r') as f:
        content = f.read()
    
    profile = json.loads(content)

    for index in range(len(agent_names)):
        profile["name"] = agent_names[index]
        if apis[index] == "vllm":
            profile["model"] = {
                "api": "vllm",
                "model": models[index], 
                "url": url
            }
        elif apis[index] == "ollama":
            profile["model"] = {
                "api": "ollama",
                "model": models[index],
                "embedding": "ollama"
            }
        else: 
            profile["model"] = models[index]

        with open(f"{agent_names[index]}.json", 'w') as f:
            json.dump(profile, f, indent=4)

def create_server_files(source_path, num_copies, world_name="Forest"):
    """Create multiple copies of server files for parallel experiments."""
    print("Creating server files...")
    print(num_copies)
    servers = []
    for i in range(num_copies):
        dest_path = f"./tasks/server_data_{i}/"
        copy_server_files(source_path, dest_path)
        print(dest_path)
        edit_file(dest_path + "server.properties", {"server-port": 55916 + i, 
                                                    "level-name": world_name})
        # edit_server_properties_file(dest_path, 55916 + i)
        servers.append((dest_path, 55916 + i))
    return servers

def edit_file(file, content_dict):
    try:
        with open(file, 'r') as f:
            lines = f.readlines()
        with open(file, 'w') as f:
            for line in lines:
                for key, value in content_dict.items():
                    if line.startswith(key):
                        f.write(f"{key}={value}\n")
                    else:
                        f.write(line)
        print(f"{file} updated with {content_dict}")  
    except Exception as e:
        print(f"Error editing file {file}: {e}")

def clean_up_server_files(num_copies):
    """Delete server files from multiple locations."""
    for i in range(num_copies):
        dest_path = f"./tasks/server_data_{i}/"
        delete_server_files(dest_path)

def copy_server_files(source_path, dest_path):
    """Copy server files to the specified location."""
    try:
        shutil.copytree(source_path, dest_path)
        print(f"Server files copied to {dest_path}")
    except Exception as e:
        print(f"Error copying server files: {e}")
    time.sleep(10)

    same_files = check_same_files(source_path, dest_path)
    if not same_files:
        copy_server_files(source_path, dest_path)
        print("The destination path does not contain all the same files as the source path.")
    else:
        print("The destination path contains all the same files as the source path.")

def check_same_files(d1, d2):

    items1 = set(os.listdir(d1))
    items2 = set(os.listdir(d2))

    if items1 != items2:
        return False
    return True

def delete_server_files(dest_path):
    """Delete server files from the specified location."""
    try:
        shutil.rmtree(dest_path)
        print(f"Server files deleted from {dest_path}")
    except Exception as e:
        print(f"Error deleting server files: {e}")
    if not os.path.exists(dest_path):
        print("Server files deleted successfully.")
    # else:
    #     print("Error deleting server files.")
    #     delete_server_files(dest_path)
    

def launch_world(server_path="./tasks/server_data/", agent_names=["andy", "jill"], session_name="server", port=55916):
    """Launch the Minecraft world."""
    print(f"Launching Minecraft world with port {port}...")
    cmd = f"cd {server_path} && java -jar server.jar"
    subprocess.run(['tmux', 'new-session', '-d', '-s', session_name], check=True)
    subprocess.run(["tmux", "send-keys", "-t", session_name, cmd, "C-m"])

    for i in range(6):
        time.sleep(10)
        if test_server_running(port):
            print("Server started successfully.")
            return
        print(f"Waiting for server... ({(i + 1) * 10}s)")

    print("Server failed to start. Retrying...")
    subprocess.run(['tmux', 'kill-session', '-t', session_name], check=False)
    launch_world(server_path, agent_names, session_name, port)

def test_server_running(port=55916):
    host = 'localhost'

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.connect((host, port))
            print("Server is running on port 55916")
            return True
        except ConnectionRefusedError:
            print("Server is not running on port 55916")
            return False

def kill_world(session_name="server"):
    """Kill the Minecraft world."""
    subprocess.run(["tmux", "send-keys", "-t", session_name, "stop", "C-m"])
    time.sleep(5)
    subprocess.run(["tmux", "kill-session", "-t", session_name])

def detach_process(command):
    """
    Launches a subprocess and detaches from it, allowing it to run independently.

    Args:
        command: A list of strings representing the command to execute, e.g., ['python', 'my_script.py'].
    """

    try:
        # Create a new process group so the child doesn't get signals intended for the parent.
        #  This is crucial for proper detachment.
        kwargs = {}
        if sys.platform == 'win32':
            kwargs.update(creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)  # Windows specific

        process = subprocess.Popen(command, 
                                   stdin=subprocess.PIPE, # Prevent stdin blocking
                                   stdout=subprocess.PIPE, # Redirect stdout
                                   stderr=subprocess.PIPE, # Redirect stderr
                                   close_fds=True,  # Close open file descriptors
                                   **kwargs)

        print(f"Process launched with PID: {process.pid}")
        return process.pid  # Return the PID of the detached process

    except FileNotFoundError:
        print(f"Error: Command not found: {command}")
        return None
    except Exception as e:
        print(f"An error occurred: {e}")
        return None

def main():
    # edit_settings("settings.js", {"profiles": ["./andy.json", "./jill.json"], "port": 55917})
    # edit_server_properties_file("../server_data/", 55917)

    parser = argparse.ArgumentParser(description='Run Minecraft AI agent experiments')
    parser.add_argument('--no_launch_world', action='store_true', help='Do not launch the Minecraft world')
    parser.add_argument('--task_path', default="tasks/multiagent_crafting_tasks.json", help='Path to the task file')
    parser.add_argument('--num_agents', default=2, type=int, help='Number of agents to run')
    parser.add_argument('--num_exp', default=1, type=int, help='Number of experiments to run')
    parser.add_argument('--num_parallel', default=1, type=int, help='Number of parallel servers to run')
    parser.add_argument('--exp_name', default="exp", help='Name of the experiment')
    parser.add_argument('--s3', action='store_true', help='Whether to upload to s3')
    parser.add_argument('--bucket_name', default="mindcraft-experiments", help='Name of the s3 bucket')
    parser.add_argument('--add_keys', action='store_true', help='Create the settings_llm_providers.json to match the environment variables')
    parser.add_argument('--template_profile', default="profiles/tasks/crafting_profile.json", help='Model to use for the agents')
    parser.add_argument('--model', default="gpt-4o-mini", help='Model to use for the agents')
    parser.add_argument('--api', default="openai", help='API to use for the agents')
    # parser.add_argument('--world_name', default="Forest", help='Name of the world')
    parser.add_argument('--insecure_coding', action='store_true', help='Enable insecure coding')
    parser.add_argument('--url', default="http://127.0.0.1:8000/v1")
    parser.add_argument('--max_messages', default=15, type=int, help='Maximum number of messages before summarizing')
    parser.add_argument('--num_examples', default=2, type=int, help='Maximum number of turns before summarizing')
    parser.add_argument('--no-pruning', action='store_true', help='Disable pruning of the actions')
    parser.add_argument('--block_conversation', action='store_true', help='Block conversation actions')
    parser.add_argument('--check', metavar='FOLDER_PATH', help='Check and evaluate results in the specified folder without running experiments')
    parser.add_argument('--usernames', default="", help='Comma-separated list of usernames for the agents')

    args = parser.parse_args()
    print(args)
    
    # If --check flag is provided, evaluate results in the specified folder and exit
    if args.check:
        check_folder_results(args.check)
        return
    
    if not args.no_launch_world:
        try: 
            subprocess.run(['tmux', 'kill-server'], check=True)
        except: 
            print("No tmux session to kill")
    
    # delete all server files
    if not args.no_launch_world:
        clean_up_server_files(args.num_parallel)
    if args.add_keys:
        update_keys_json()

    # change task file to include usernames
    with open(args.task_path, 'r') as f:
        content = f.read()
        task = json.loads(content) 
    # check if human count for first task is non zero
    if "human_count" in task[list(task.keys())[0]]:
        # check if human count is non zero
        human_count = task[list(task.keys())[0]]["human_count"]
        username_lst = args.usernames.replace(" ", "").split(",")
        if len(username_lst) != human_count:
            raise ValueError(f"Number of usernames provided ({len(username_lst)}) does not match human count ({human_count})")
        if human_count > 0:
            for task_id in task.keys():
                task[task_id]["usernames"] = username_lst
        # dump to task_path 
        with open(args.task_path, 'w') as f:
            json.dump(task, f, indent=4)
    
    launch_parallel_experiments(args.task_path, 
                                num_exp=args.num_exp, 
                                exp_name=args.exp_name, 
                                num_parallel=args.num_parallel, 
                                s3=args.s3, 
                                bucket_name=args.bucket_name, 
                                template_profile=args.template_profile, 
                                model=args.model, 
                                api=args.api, 
                                insecure_coding=args.insecure_coding,
                                num_agents=args.num_agents, 
                                url=args.url, 
                                max_messages=args.max_messages,
                                num_examples=args.num_examples, 
                                no_pruning=args.no_pruning, 
                                block_conversation=args.block_conversation,
                                run_in_tmux=not args.no_launch_world)

if __name__ == "__main__":
    main()