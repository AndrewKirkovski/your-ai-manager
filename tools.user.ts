import {Tool} from "./tool.types";
import {setUserGoal, getUserGoal, clearUserGoal, setReplyMaxTokens, getReplyMaxTokens, grantTokenWindow} from "./userStore";
import {textify} from "./telegramFormat";

/** Elevated budget and window a consent grant opens. Kept in sync with the
 * constants of the same purpose in aiService.ts. */
const GRANT_BUDGET = 64000;
const GRANT_WINDOW_MINUTES = 5;

export const SetGoal: Tool = {
    name: 'SetGoal',
    description: 'Set or update the user\'s main life goal. This is their overarching objective that guides task and routine management.',
    parameters: {
        type: 'object',
        properties: {
            goal: {
                type: 'string',
                description: 'The user\'s goal statement'
            }
        },
        required: ['goal']
    },
    execute: async (args: { userId: number; goal: string }) => {
        const goal = textify(args.goal);
        await setUserGoal(args.userId, goal);
        return { success: true, message: `Goal set to: "${goal}"` };
    }
};

/** Reply-budget bounds. The floor keeps a user from setting a budget so small
 * that thinking alone would exhaust it; the ceiling matches the escalation
 * ceiling in aiService, which is itself well inside the model's output cap. */
const MIN_REPLY_TOKENS = 2000;
const MAX_REPLY_TOKENS = 64000;

export const SetReplyTokenBudget: Tool = {
    name: 'SetReplyTokenBudget',
    description: 'Raise or lower the token budget for your own replies to this user. '
        + 'Call this ONLY after the user agrees to it. You are told to ask when a previous '
        + 'answer could only be completed by spending more than the current budget — a bigger '
        + 'budget means complex answers succeed on the first try instead of being retried. '
        + 'Pass reset=true to go back to the default.',
    parameters: {
        type: 'object',
        properties: {
            maxTokens: {
                type: 'number',
                description: `Tokens per reply, ${MIN_REPLY_TOKENS}–${MAX_REPLY_TOKENS}. Ignored when reset is true.`
            },
            reset: {
                type: 'boolean',
                description: 'Restore the default budget instead of setting a specific one.'
            }
        }
    },
    execute: async (args: { userId: number; maxTokens?: number; reset?: boolean }) => {
        if (args.reset) {
            await setReplyMaxTokens(args.userId, null);
            return { success: true, message: 'Reply budget reset to the default.' };
        }
        if (typeof args.maxTokens !== 'number' || !Number.isFinite(args.maxTokens)) {
            return { success: false, message: 'maxTokens must be a number, or pass reset=true.' };
        }
        const requested = Math.round(args.maxTokens);
        if (requested < MIN_REPLY_TOKENS || requested > MAX_REPLY_TOKENS) {
            return {
                success: false,
                message: `maxTokens must be between ${MIN_REPLY_TOKENS} and ${MAX_REPLY_TOKENS} (got ${requested}).`
            };
        }
        await setReplyMaxTokens(args.userId, requested);
        return { success: true, message: `Reply budget set to ${requested} tokens.` };
    }
};

export const GetReplyTokenBudget: Tool = {
    name: 'GetReplyTokenBudget',
    description: 'Check the token budget currently used for replies to this user.',
    parameters: {
        type: 'object',
        properties: {}
    },
    execute: async (args: { userId: number }) => {
        const budget = await getReplyMaxTokens(args.userId);
        return budget === null
            ? { isDefault: true, message: 'Using the default reply budget.' }
            : { isDefault: false, maxTokens: budget };
    }
};

export const GrantMoreTokens: Tool = {
    name: 'GrantMoreTokens',
    description: `Give yourself a larger token budget (${GRANT_BUDGET} tokens/reply) for the next ${GRANT_WINDOW_MINUTES} minutes so you can finish a complex answer or a multi-step task. The window covers every request in it — follow-up tool calls and their processing too, not just one message — so one grant finishes the whole task. `
        + 'Call this ONLY after the user has agreed to let you spend more tokens (for example, they said yes/да/давай to your question about it). Do not call it on your own initiative without that agreement. After calling it, continue and answer the request that did not fit before.',
    parameters: {
        type: 'object',
        properties: {}
    },
    execute: async (args: { userId: number }) => {
        const until = await grantTokenWindow(args.userId, GRANT_BUDGET, GRANT_WINDOW_MINUTES);
        return {
            success: true,
            maxTokens: GRANT_BUDGET,
            windowMinutes: GRANT_WINDOW_MINUTES,
            until,
            message: `Budget raised to ${GRANT_BUDGET} tokens/reply until ${until}. Now finish the request that ran out of room.`,
        };
    }
};

export const GetGoal: Tool = {
    name: 'GetGoal',
    description: 'Retrieve the user\'s current goal.',
    parameters: {
        type: 'object',
        properties: {}
    },
    execute: async (args: { userId: number }) => {
        const goal = await getUserGoal(args.userId);
        if (!goal) {
            return { hasGoal: false, message: 'No goal set' };
        }
        return { hasGoal: true, goal };
    }
};

export const ClearGoal: Tool = {
    name: 'ClearGoal',
    description: 'Clear/remove the user\'s current goal.',
    parameters: {
        type: 'object',
        properties: {}
    },
    execute: async (args: { userId: number }) => {
        await clearUserGoal(args.userId);
        return { success: true, message: 'Goal cleared' };
    }
};
