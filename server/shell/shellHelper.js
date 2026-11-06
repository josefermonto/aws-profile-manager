'use strict';

/**
 * The `awspm` zsh helper: `awspm use <profile>` sets AWS_PROFILE in that terminal
 * only, with tab completion, and a colored prompt tag such as [ACME PROD ADMIN].
 *
 * The service keeps ~/.aws-profile-manager/profiles.tsv up to date (name, tag,
 * 256-color code), and the helper reads it, so the prompt never waits on the
 * network. ~/.zshrc is only touched when the user asks, by appending one line.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { readText, writeAtomic, ensureDir } = require('../core/fsx');

const MARKER = '# AWS Profile Manager';
const sourceLine = (scriptPath) => `[ -f "${scriptPath}" ] && source "${scriptPath}"  ${MARKER}`;

// zsh 256-color codes for the environment colors (core/../domain/projects.js ENV_COLORS).
const COLOR_256 = { red: 196, orange: 208, yellow: 220, green: 40, teal: 37, blue: 33, purple: 129, pink: 199 };

function renderScript({ appHome, port }) {
    return `# AWS Profile Manager shell helper. Written by the AWS Profile Manager service; edits are overwritten.
#   awspm use <profile>   use a profile in this terminal (sets AWS_PROFILE)
#   awspm off             stop using a profile in this terminal
#   awspm ls              list profiles
#   awspm who             show the profile this terminal uses
#   awspm open            open AWS Profile Manager in the browser

typeset -g _AWSPM_HOME="${appHome}"
typeset -g _AWSPM_URL="http://localhost:${port}"
typeset -gA _AWSPM_TAGS _AWSPM_COLORS
typeset -g _AWSPM_TSV_STAMP=""
typeset -g _AWSPM_PROMPT=""
zmodload -F zsh/stat b:zstat 2>/dev/null

_awspm_load() {
  local f="$_AWSPM_HOME/profiles.tsv" stamp name tag color
  [[ -r $f ]] || return 0
  stamp=$(zstat +mtime "$f" 2>/dev/null)
  [[ $stamp == "$_AWSPM_TSV_STAMP" ]] && return 0
  _AWSPM_TSV_STAMP=$stamp
  _AWSPM_TAGS=() _AWSPM_COLORS=()
  while IFS=$'\\t' read -r name tag color; do
    [[ -n $name ]] || continue
    _AWSPM_TAGS[$name]=$tag
    _AWSPM_COLORS[$name]=$color
  done < "$f"
}

_awspm_names() {
  _awspm_load
  print -l -- \${(k)_AWSPM_TAGS}
}

awspm() {
  case "$1" in
    use)
      if [[ -z $2 ]]; then print -u2 "usage: awspm use <profile>"; return 1; fi
      _awspm_load
      if (( ! \${+_AWSPM_TAGS[$2]} )) && ! aws configure list-profiles 2>/dev/null | grep -qxF -- "$2"; then
        print -u2 "awspm: no profile named '$2' (awspm ls lists them)"
        return 1
      fi
      export AWS_PROFILE=$2
      if [[ -n $AWS_ACCESS_KEY_ID$AWS_SECRET_ACCESS_KEY$AWS_SESSION_TOKEN ]]; then
        unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
        print "awspm: cleared AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN in this terminal (they override profiles)"
      fi
      print "AWS_PROFILE=$2"
      ;;
    off)
      unset AWS_PROFILE
      print "AWS_PROFILE cleared"
      ;;
    ls|list)
      _awspm_load
      local name
      for name in \${(ko)_AWSPM_TAGS}; do
        if [[ -n \${_AWSPM_TAGS[$name]} ]]; then
          print -P -- "%F{\${_AWSPM_COLORS[$name]:-245}}[\${_AWSPM_TAGS[$name]}]%f $name"
        else
          print -- "  $name"
        fi
      done
      ;;
    who|"")
      print "AWS_PROFILE=\${AWS_PROFILE:-<not set>}"
      ;;
    open)
      open "$_AWSPM_URL"
      ;;
    *)
      print -u2 "usage: awspm use <profile> | awspm off | awspm ls | awspm who | awspm open"
      return 1
      ;;
  esac
}

_awspm() {
  local -a subcommands profiles
  subcommands=('use:use a profile in this terminal' 'off:stop using a profile' 'ls:list profiles' 'who:show the current profile' 'open:open AWS Profile Manager')
  if (( CURRENT == 2 )); then
    _describe 'command' subcommands
  elif (( CURRENT == 3 )) && [[ $words[2] == use ]]; then
    profiles=(\${(f)"$(_awspm_names)"})
    _describe 'profile' profiles
  fi
}
(( $+functions[compdef] )) && compdef _awspm awspm

_awspm_precmd() {
  _awspm_load
  if [[ -n $AWS_PROFILE ]]; then
    local tag=\${_AWSPM_TAGS[$AWS_PROFILE]:-$AWS_PROFILE}
    _AWSPM_PROMPT="%F{\${_AWSPM_COLORS[$AWS_PROFILE]:-245}}[\${tag}]%f "
  else
    _AWSPM_PROMPT=""
  fi
}
autoload -Uz add-zsh-hook && add-zsh-hook precmd _awspm_precmd
setopt prompt_subst
[[ $PROMPT == *'\${_AWSPM_PROMPT}'* ]] || PROMPT='\${_AWSPM_PROMPT}'$PROMPT
`;
}

function createShellHelper({ paths, port, now = () => new Date() }) {
    async function writeScript() {
        await ensureDir(paths.appHome);
        await writeAtomic(paths.shellScript, renderScript({ appHome: paths.appHome, port }), 0o644);
    }

    let lastTsv = null;
    /** rows: [{ name, tag, color }] (color is an env color name). Writes only when something changed. */
    async function writeProfiles(rows) {
        const text = rows
            .map((r) => [r.name, r.tag ?? '', r.color ? COLOR_256[r.color] ?? 245 : ''].join('\t'))
            .join('\n');
        if (text === lastTsv) return;
        await ensureDir(paths.appHome);
        await writeAtomic(paths.profilesTsv, text ? `${text}\n` : '', 0o644);
        lastTsv = text;
    }

    async function status() {
        const zshrc = (await readText(paths.zshrc)) ?? '';
        return { scriptPath: paths.shellScript, zshrc: paths.zshrc, installed: zshrc.includes(paths.shellScript), sourceLine: sourceLine(paths.shellScript) };
    }

    /** Appends the source line to ~/.zshrc (after copying it to the backups folder). */
    async function install() {
        await writeScript();
        const current = await readText(paths.zshrc);
        if (current?.includes(paths.shellScript)) return status();
        if (current) {
            await ensureDir(paths.backups);
            await writeAtomic(path.join(paths.backups, `zshrc.${now().toISOString().replace(/[:.]/g, '-')}.bak`), current);
        }
        const prefix = current && !current.endsWith('\n') ? '\n' : '';
        await fs.appendFile(paths.zshrc, `${prefix}${sourceLine(paths.shellScript)}\n`);
        return status();
    }

    return { writeScript, writeProfiles, status, install };
}

module.exports = { createShellHelper, renderScript, COLOR_256 };
