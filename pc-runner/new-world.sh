#!/usr/bin/env bash
# (a copy: it runs on the Minecraft server machine as ~/mindcraft-speedrun/new-world.sh, see run-pc.sh)
# Makes a brand-new world (random seed) for the next speedrun, the same way run-overnight.sh does between runs, for a
# runner on another machine:   ssh kieron@192.168.1.144 mindcraft-speedrun/new-world.sh
# Prints the new world's name once the server says it's ready. Keeps the newest 3 andy-* worlds, never anything else.
MC=/srv/minecraft
name="andy-$(date +%m%d-%H%M%S)"
sudo systemctl stop minecraft
sudo sed -i -e "s/^level-name=.*/level-name=$name/" -e "s/^level-seed=.*/level-seed=/" "$MC/server.properties"
since="$(date "+%F %T")"
sudo systemctl start minecraft
# world generation on this old CPU takes a while: wait for the server to say it's ready
for i in $(seq 1 90); do
    journalctl -u minecraft --since "$since" --no-pager 2>/dev/null | grep -q "Done (" && break
    sleep 2
done
sleep 3
ls -1dt "$MC"/andy-* 2>/dev/null | tail -n +4 | while read -r old; do
    case "$(basename "$old")" in andy-*) sudo rm -rf -- "$old" ;; esac
done
echo "$name"
