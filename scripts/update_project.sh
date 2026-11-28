#!/bin/sh
# Safely fast-forward a clean checkout to its configured upstream branch.

set -u

PROGRAM=${0##*/}
MODE=
REPO_GIVEN=0

# Do not let a caller's Git environment silently redirect --repo elsewhere.
for variable in GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT; do
    # Only the fixed variable names above are evaluated, never caller content.
    eval 'present=${'"$variable"'+yes}'
    if [ "$present" = yes ]; then
        printf '%s: blocked: Git environment overrides are unsupported\n' "$PROGRAM" >&2
        exit 1
    fi
done
for dependency in git dirname cat mkdir rmdir grep awk; do
    command -v "$dependency" >/dev/null 2>&1 || {
        printf '%s: blocked: a required command is unavailable\n' "$PROGRAM" >&2
        exit 1
    }
done
# --check must not refresh the index or lazily fetch missing objects. Disable
# repository hooks/fsmonitor and automatic maintenance, not checkout safeguards.
GIT_OPTIONAL_LOCKS=0
GIT_NO_LAZY_FETCH=1
GIT_TERMINAL_PROMPT=0
export GIT_OPTIONAL_LOCKS GIT_NO_LAZY_FETCH GIT_TERMINAL_PROMPT
git() {
    command git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c gc.auto=0 -c maintenance.auto=false "$@"
}

case $0 in
    */*) SCRIPT_LOCATION=$0 ;;
    *) SCRIPT_LOCATION=$(command -v "$0" 2>/dev/null) || SCRIPT_LOCATION=$0 ;;
esac
case $SCRIPT_LOCATION in *'
'*)
    printf '%s: blocked: script paths containing newlines are unsupported\n' "$PROGRAM" >&2
    exit 1
    ;;
esac
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$SCRIPT_LOCATION")" 2>/dev/null && pwd -P && printf '.') || {
    printf '%s: blocked: cannot locate the script directory\n' "$PROGRAM" >&2
    exit 1
}
SCRIPT_DIR=${SCRIPT_DIR%.}
SCRIPT_DIR=${SCRIPT_DIR%?}
REPO=$(CDPATH= cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P && printf '.') || {
    printf '%s: blocked: cannot locate the script checkout\n' "$PROGRAM" >&2
    exit 1
}
REPO=${REPO%.}
REPO=${REPO%?}

usage() {
    cat <<EOF
Usage: $PROGRAM (--check | --apply) [--repo PATH]

  --check       Offline status check against the locally cached upstream ref.
  --apply       Fetch the configured upstream and fast-forward if safely behind.
  --repo PATH   Checkout to operate on (default: checkout containing this script).

The script never chooses a remote/branch, changes branches, installs dependencies,
builds images, or deletes/stashes user files. See the deployment documentation.
EOF
}

fail() {
    printf '%s: blocked: %s\n' "$PROGRAM" "$1" >&2
    exit 1
}

check_storage() {
    partial=$(git -C "$TOP" config --get-regexp '^(extensions\.partialclone|remote\..*\.(promisor|partialclonefilter))$' 2>/dev/null)
    config_status=$?
    [ "$config_status" -le 1 ] || fail 'cannot inspect partial clone configuration'
    [ -z "$partial" ] || fail 'partial/promisor checkout is unsupported; materialize a full clone manually'
    filters=$(git -C "$TOP" config --get-regexp '^filter\.' 2>/dev/null)
    config_status=$?
    [ "$config_status" -le 1 ] || fail 'cannot inspect checkout filter configuration'
    [ -z "$filters" ] || fail 'configured checkout filters are unsupported; review hydration requirements manually'
}

has_gitlinks() {
    printf '%s\n' "$1" | grep '^160000 ' >/dev/null 2>&1
    scan_status=$?
    [ "$scan_status" -le 1 ] || fail 'cannot scan Git entries for submodules'
    return "$scan_status"
}

while [ "$#" -gt 0 ]; do
    case $1 in
        --check|--apply)
            [ -z "$MODE" ] || fail 'choose exactly one of --check or --apply'
            MODE=$1
            ;;
        --repo)
            [ "$REPO_GIVEN" -eq 0 ] || fail 'specify --repo only once'
            REPO_GIVEN=1
            [ "$#" -ge 2 ] || fail '--repo requires a path'
            [ -n "$2" ] || fail '--repo requires a nonempty path'
            case $2 in --*) fail '--repo requires a path, not an option' ;; esac
            REPO=$2
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            fail 'unknown argument (use --help for usage)'
            ;;
    esac
    shift
done

[ -n "$MODE" ] || fail 'specify --check or --apply'
# Command substitution strips trailing newlines. Refuse such checkout directory
# names instead of risking operation on a similarly named sibling. Files inside
# the checkout may still contain spaces, tabs, or newlines in their names.
case $REPO in *'
'*) fail 'checkout directory paths containing newlines are unsupported' ;; esac

if ! TOP=$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null && printf '.'); then
    fail 'target is not a valid Git working checkout'
fi
TOP=${TOP%.}
TOP=${TOP%?}
case $TOP in *'
'*) fail 'checkout directory paths containing newlines are unsupported' ;; esac
if [ "$(git -C "$TOP" rev-parse --is-bare-repository 2>/dev/null)" != false ]; then
    fail 'bare repositories are not supported'
fi
check_storage
if [ -z "$(git -C "$TOP" branch --show-current 2>/dev/null)" ]; then
    fail 'checkout is detached; check out the intended named branch manually'
fi
BRANCH=$(git -C "$TOP" branch --show-current 2>/dev/null) || fail 'cannot read current branch'
START_HEAD=$(git -C "$TOP" rev-parse --verify HEAD 2>/dev/null) || fail 'cannot resolve HEAD'
UPSTREAM_REF=$(git -C "$TOP" for-each-ref --format='%(upstream)' "refs/heads/$BRANCH" 2>/dev/null) || fail 'cannot resolve configured upstream'
[ -n "$UPSTREAM_REF" ] || fail 'current branch has no configured upstream'
UPSTREAM=${UPSTREAM_REF#refs/remotes/}
REMOTE=$(git -C "$TOP" config --get-all "branch.$BRANCH.remote" 2>/dev/null) || fail 'configured upstream remote is unavailable'
MERGE_REF=$(git -C "$TOP" config --get-all "branch.$BRANCH.merge" 2>/dev/null) || fail 'configured upstream branch is unavailable'

case $REMOTE in
    ''|.|-*) fail 'upstream must be a configured named remote (local-branch upstreams are unsupported)' ;;
esac
git check-ref-format "refs/remotes/$REMOTE/placeholder" >/dev/null 2>&1 || fail 'invalid upstream remote name'
git -C "$TOP" config --get "remote.$REMOTE.url" >/dev/null 2>&1 || fail 'configured named remote has no URL'
git check-ref-format "$MERGE_REF" >/dev/null 2>&1 || fail 'invalid upstream branch configuration'
git check-ref-format "$UPSTREAM_REF" >/dev/null 2>&1 || fail 'invalid upstream tracking configuration'
case $MERGE_REF in
    refs/heads/*) ;;
    *) fail 'configured upstream does not identify a remote branch' ;;
esac
case $UPSTREAM_REF in
    refs/remotes/*) ;;
    *) fail 'configured upstream is not a remote-tracking ref' ;;
esac

GIT_DIR=$(git -C "$TOP" rev-parse --absolute-git-dir 2>/dev/null && printf '.') || fail 'cannot locate Git metadata'
GIT_DIR=${GIT_DIR%.}
GIT_DIR=${GIT_DIR%?}
case $GIT_DIR in *'
'*) fail 'Git metadata directory paths containing newlines are unsupported' ;; esac
LOCK_DIR=$GIT_DIR/mindcraft-project-update.lock
LOCK_HELD=0

cleanup() {
    if [ "$LOCK_HELD" -eq 1 ]; then
        rmdir "$LOCK_DIR" 2>/dev/null || :
    fi
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

if [ "$MODE" = --apply ]; then
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        fail 'another update may be running, or an update lock exists; inspect and remove only a confirmed stale lock manually'
    fi
    LOCK_HELD=1
fi

check_checkout() {
    current_branch=$(git -C "$TOP" branch --show-current 2>/dev/null) || fail 'cannot recheck branch'
    [ "$current_branch" = "$BRANCH" ] || fail 'current branch changed during the operation'
    current_head=$(git -C "$TOP" rev-parse --verify HEAD 2>/dev/null) || fail 'cannot recheck HEAD'
    [ "$current_head" = "$START_HEAD" ] || fail 'HEAD changed during the operation'

    shallow=$(git -C "$TOP" rev-parse --is-shallow-repository 2>/dev/null) || fail 'cannot inspect shallow state'
    case $shallow in
        false) ;;
        true) fail 'shallow checkout cannot establish safe ancestry; deepen/unshallow it manually' ;;
        *) fail 'cannot establish full checkout ancestry' ;;
    esac
    sparse=$(git -C "$TOP" config --bool core.sparseCheckout 2>/dev/null)
    config_status=$?
    [ "$config_status" -le 1 ] || fail 'cannot inspect sparse checkout configuration'
    [ "$sparse" != true ] || fail 'sparse checkout is unsupported; expand it manually before updating'

    check_storage

    for state_name in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD REBASE_HEAD rebase-apply rebase-merge sequencer BISECT_LOG; do
        state_path=$(git -C "$TOP" rev-parse --path-format=absolute --git-path "$state_name" 2>/dev/null) || fail 'cannot inspect Git operation state'
        [ ! -e "$state_path" ] && [ ! -L "$state_path" ] || fail 'an unfinished merge/rebase/cherry-pick/revert/bisect is in progress'
    done

    entries=$(git -C "$TOP" ls-files --stage 2>/dev/null) || fail 'cannot inspect index entries'
    if has_gitlinks "$entries"; then
        fail 'checkout contains submodules/gitlinks; update them explicitly outside this script'
    fi
    flags=$(git -C "$TOP" ls-files -v 2>/dev/null) || fail 'cannot inspect index flags'
    printf '%s\n' "$flags" | awk 'substr($0,1,1) ~ /[a-z]/ || substr($0,1,1) == "S" { found=1 } END { exit !found }'
    flags_status=$?
    if [ "$flags_status" -eq 0 ]; then
        fail 'tracked paths have assume-unchanged or skip-worktree flags; review and clear them manually'
    fi
    [ "$flags_status" -eq 1 ] || fail 'cannot scan index flags'

    status=$(git -C "$TOP" status --porcelain --untracked-files=all 2>/dev/null) || fail 'cannot inspect working tree status'
    [ -z "$status" ] || fail 'working tree/index is not clean (tracked changes or untracked files); preserve and review them manually'
}

classify() {
    candidate=$1
    if git -C "$TOP" merge-base --is-ancestor "$START_HEAD" "$candidate" >/dev/null 2>&1; then
        if [ "$START_HEAD" = "$candidate" ]; then
            RELATION=equal
        else
            RELATION=behind
        fi
    elif git -C "$TOP" merge-base --is-ancestor "$candidate" "$START_HEAD" >/dev/null 2>&1; then
        RELATION=ahead
    else
        RELATION=diverged
    fi
}

check_checkout

if [ "$MODE" = --check ]; then
    CACHED=$(git -C "$TOP" rev-parse --verify "$UPSTREAM_REF^{commit}" 2>/dev/null) || fail 'configured upstream has no locally cached commit; run --apply to fetch it'
    classify "$CACHED"
    printf 'Offline check: branch %s vs cached upstream %s: %s. No network or repository changes were made.\n' "$BRANCH" "$UPSTREAM" "$RELATION"
    case $RELATION in
        equal|behind) exit 0 ;;
        ahead) fail 'local branch is ahead of its cached upstream; no update attempted' ;;
        diverged) fail 'local branch and cached upstream have diverged; reconcile manually' ;;
    esac
fi

# Fetch only the configured branch into its configured tracking ref, with no force.
# Suppress Git's raw diagnostics because remote URLs may embed credentials.
if ! git -C "$TOP" fetch --no-force --no-tags --no-prune --no-prune-tags --no-recurse-submodules --no-auto-maintenance --no-write-commit-graph --refmap= -- "$REMOTE" "$MERGE_REF:$UPSTREAM_REF" >/dev/null 2>&1; then
    fail 'fetch failed; verify connectivity/credentials and upstream configuration (Git output suppressed)'
fi

TARGET=$(git -C "$TOP" rev-parse --verify "$UPSTREAM_REF^{commit}" 2>/dev/null) || fail 'fetched upstream did not resolve to a commit'
target_tree=$(git -C "$TOP" ls-tree -r "$TARGET" 2>/dev/null) || fail 'cannot inspect upstream tree'
if has_gitlinks "$target_tree"; then
    fail 'upstream contains submodules/gitlinks; update them explicitly outside this script'
fi

# Fail closed if a target tree contains Git LFS pointer content. This updater does
# not download or hydrate LFS objects itself.
# Match a pointer-version line, not source/docs mentioning the signature (which
# includes this updater itself). Whitespace also covers CRLF pointer files.
git -C "$TOP" grep -E -q '^version https://git-lfs[.]github[.]com/spec/v1[[:space:]]*$' "$TARGET" -- >/dev/null 2>&1
lfs_status=$?
if [ "$lfs_status" -eq 0 ]; then
    fail 'upstream contains Git LFS pointer files; hydrate/verify LFS objects manually before updating'
fi
[ "$lfs_status" -eq 1 ] || fail 'cannot inspect upstream content for Git LFS pointers'

# Revalidate even when already current: a successful --apply may gate deployment.
# This catches ordinary concurrent edits, but cannot serialize unrelated writers.
check_checkout
CURRENT_UPSTREAM=$(git -C "$TOP" for-each-ref --format='%(upstream)' "refs/heads/$BRANCH" 2>/dev/null) || fail 'configured upstream changed during fetch'
[ "$CURRENT_UPSTREAM" = "$UPSTREAM_REF" ] || fail 'configured upstream changed during fetch'
CURRENT_REMOTE=$(git -C "$TOP" config --get-all "branch.$BRANCH.remote" 2>/dev/null) || fail 'configured upstream changed during fetch'
CURRENT_MERGE=$(git -C "$TOP" config --get-all "branch.$BRANCH.merge" 2>/dev/null) || fail 'configured upstream changed during fetch'
[ "$CURRENT_REMOTE" = "$REMOTE" ] && [ "$CURRENT_MERGE" = "$MERGE_REF" ] || fail 'configured upstream changed during fetch'
CURRENT_TARGET=$(git -C "$TOP" rev-parse --verify "$UPSTREAM_REF^{commit}" 2>/dev/null) || fail 'upstream ref disappeared before update'
[ "$CURRENT_TARGET" = "$TARGET" ] || fail 'upstream ref changed during update; rerun after reviewing state'

classify "$TARGET"
case $RELATION in
    equal)
        printf 'Already current: branch %s equals fetched upstream %s.\n' "$BRANCH" "$UPSTREAM"
        exit 0
        ;;
    ahead) fail 'local branch is ahead of fetched upstream; no update attempted' ;;
    diverged) fail 'local branch and fetched upstream have diverged; reconcile manually' ;;
    behind) ;;
esac

if ! git -C "$TOP" -c advice.skippedCherryPicks=false merge --ff-only --no-overwrite-ignore "$TARGET" >/dev/null 2>&1; then
    fail 'fast-forward failed (possibly an ignored-path collision); inspect HEAD, index and files before retrying; no rollback attempted'
fi

FINAL_HEAD=$(git -C "$TOP" rev-parse --verify HEAD 2>/dev/null) || fail 'cannot verify resulting HEAD'
[ "$FINAL_HEAD" = "$TARGET" ] || fail 'post-update HEAD does not match the fetched upstream commit'
printf 'Updated branch %s by fast-forward to fetched upstream %s. No dependencies or Docker actions were run.\n' "$BRANCH" "$UPSTREAM"
exit 0
