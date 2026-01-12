import {Tool} from "./tool.types";
import {setUserGoal, getUserGoal, clearUserGoal} from "./userStore";

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
        await setUserGoal(args.userId, args.goal);
        return { success: true, message: `Goal set to: "${args.goal}"` };
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
