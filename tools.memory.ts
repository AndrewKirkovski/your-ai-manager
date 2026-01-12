import {Tool} from "./tool.types";
import {
    updateUserMemory,
    getUserMemory,
    getAllUserMemory,
    deleteUserMemory
} from "./userStore";

export const UpdateMemory: Tool = {
    name: 'UpdateMemory',
    description: 'Store or update a user preference, fact, or piece of information. Use this to remember things about the user.',
    parameters: {
        type: 'object',
        properties: {
            key: {
                type: 'string',
                description: 'The memory key (e.g., "favorite_color", "work_schedule", "pet_name")'
            },
            value: {
                type: 'string',
                description: 'The value to store'
            }
        },
        required: ['key', 'value']
    },
    execute: async (args: { userId: number; key: string; value: string }) => {
        await updateUserMemory(args.userId, args.key, args.value);
        return { success: true, message: `Memory "${args.key}" updated to "${args.value}"` };
    }
};

export const GetMemory: Tool = {
    name: 'GetMemory',
    description: 'Retrieve a specific stored user preference or piece of information.',
    parameters: {
        type: 'object',
        properties: {
            key: {
                type: 'string',
                description: 'The memory key to retrieve'
            }
        },
        required: ['key']
    },
    execute: async (args: { userId: number; key: string }) => {
        const value = await getUserMemory(args.userId, args.key);
        if (value === undefined) {
            return { found: false, message: `No memory found for key "${args.key}"` };
        }
        return { found: true, key: args.key, value };
    }
};

export const ListMemory: Tool = {
    name: 'ListMemory',
    description: 'List all stored user preferences and information.',
    parameters: {
        type: 'object',
        properties: {}
    },
    execute: async (args: { userId: number }) => {
        const memory = await getAllUserMemory(args.userId);
        const entries = Object.entries(memory);
        if (entries.length === 0) {
            return { count: 0, message: 'No memories stored', memories: {} };
        }
        return { count: entries.length, memories: memory };
    }
};

export const DeleteMemory: Tool = {
    name: 'DeleteMemory',
    description: 'Remove a stored preference or piece of information.',
    parameters: {
        type: 'object',
        properties: {
            key: {
                type: 'string',
                description: 'The memory key to delete'
            }
        },
        required: ['key']
    },
    execute: async (args: { userId: number; key: string }) => {
        const deleted = await deleteUserMemory(args.userId, args.key);
        if (deleted) {
            return { success: true, message: `Memory "${args.key}" deleted` };
        }
        return { success: false, message: `Memory "${args.key}" not found` };
    }
};
