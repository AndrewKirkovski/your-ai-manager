// Telegram dispatches slash commands separately from ordinary messages. Hold
// ambiguous commands before either dispatch path can start a booking decision.
const readOnlyCommands = new Set(['goal', 'cleargoal', 'tasks', 'routines', 'memory', 'stats', 'help', 'start']);

export function slashMessageNeedsAvailabilityHold(text: string): boolean {
    if (!text.startsWith('/')) return false;
    const trimmed = text.trim();
    const command = /^\/([A-Za-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/.exec(trimmed);
    if (!command) return true;
    const name = command[1].toLowerCase();
    const argument = command[2]?.trim();
    if (readOnlyCommands.has(name) && !argument) return false;
    if (name === 'version' && (!argument || /^[A-Za-z0-9_-]{8,64}$/.test(argument))) return false;
    return true;
}

export function slashMessageNeedsIngressHold(text: string): boolean {
    // The /goal onText handler already takes its hold synchronously. A second
    // ingress hold would replace that token and leave the pause unexplained.
    // Match its captured argument exactly: dot does not cross a newline, so a
    // multiline /goal message may contain schedule text that handler ignores.
    const goalArgument = /\/goal(.*)/.exec(text)?.[1]?.trim();
    return slashMessageNeedsAvailabilityHold(text) && !goalArgument;
}
