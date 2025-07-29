import {Tool} from "./tool.types";
import {
    addUserRoutine,
    generateShortId,
    getAllRoutines,
    getRoutine,
    Routine,
    updateUserRoutine
} from "./userStore";

export const add_routine: Tool = {
    name: 'add_routine',
    description: 'Create a new routine',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'The name of the routine'
            },
            cron: {
                type: 'string',
                description: 'The cron schedule for the routine (e.g., "0 9 * * 1" for every Monday at 9 AM)'
            },
            default_annoyance: {
                type: 'string',
                description: 'The default annoyance level for tasks created by this routine',
                enum: ['low', 'med', 'high']
            },
            requires_action: {
                type: 'boolean',
                description: 'Whether tasks created by this routine require user action (default: true)'
            },
            is_active: {
                type: 'boolean',
                description: 'Whether the routine is active (default: true)'
            }
        },
        required: ['name', 'cron']
    },
    execute: async (args: {
        userId: string;
        name: string;
        cron: string;
        default_annoyance?: string;
        requires_action?: boolean;
        is_active?: boolean;
    }) => {
        const userId = parseInt(args.userId);

        // Validate annoyance level if provided
        if (args.default_annoyance && !['low', 'med', 'high'].includes(args.default_annoyance)) {
            throw new Error(`Invalid annoyance level: ${args.default_annoyance}. Must be one of: low, med, high`);
        }

        const newRoutine: Routine = {
            id: generateShortId(),
            name: args.name,
            cron: args.cron,
            defaultAnnoyance: (args.default_annoyance as 'low' | 'med' | 'high') || 'low',
            requiresAction: args.requires_action ?? true,
            isActive: args.is_active ?? true,
            stats: { completed: 0, failed: 0 },
            createdAt: new Date()
        };

        await addUserRoutine(userId, newRoutine);

        return {
            success: true,
            routine: newRoutine,
            message: `Routine "${newRoutine.name}" created successfully with schedule: ${newRoutine.cron}`
        };
    }
};

export const update_routine: Tool = {
    name: 'update_routine',
    description: 'Update an existing routine',
    parameters: {
        type: 'object',
        properties: {
            routine_id: {
                type: 'string',
                description: 'The ID of the routine to update'
            },
            name: {
                type: 'string',
                description: 'The new name for the routine (optional)'
            },
            cron: {
                type: 'string',
                description: 'The new cron schedule for the routine (optional)'
            },
            default_annoyance: {
                type: 'string',
                description: 'The new default annoyance level for tasks created by this routine (optional)',
                enum: ['low', 'med', 'high']
            },
            requires_action: {
                type: 'boolean',
                description: 'Whether tasks created by this routine require user action (optional)'
            },
            is_active: {
                type: 'boolean',
                description: 'Whether the routine is active (optional)'
            }
        },
        required: ['routine_id']
    },
    execute: async (args: {
        userId: string;
        routine_id: string;
        name?: string;
        cron?: string;
        default_annoyance?: string;
        requires_action?: boolean;
        is_active?: boolean;
    }) => {
        const userId = parseInt(args.userId);
        const routineId = args.routine_id;

        // Validate annoyance level if provided
        if (args.default_annoyance && !['low', 'med', 'high'].includes(args.default_annoyance)) {
            throw new Error(`Invalid annoyance level: ${args.default_annoyance}. Must be one of: low, med, high`);
        }

        // Check if routine exists
        const existingRoutine = await getRoutine(userId, routineId);
        if (!existingRoutine) {
            throw new Error(`Routine with ID ${routineId} not found`);
        }

        // Update the routine
        await updateUserRoutine(userId, routineId, (routine) => {
            if (args.name !== undefined) routine.name = args.name;
            if (args.cron !== undefined) routine.cron = args.cron;
            if (args.default_annoyance !== undefined) routine.defaultAnnoyance = args.default_annoyance as 'low' | 'med' | 'high';
            if (args.requires_action !== undefined) routine.requiresAction = args.requires_action;
            if (args.is_active !== undefined) routine.isActive = args.is_active;
        });

        // Get the updated routine
        const updatedRoutine = await getRoutine(userId, routineId);

        return {
            success: true,
            routine: updatedRoutine,
            message: `Routine "${updatedRoutine?.name}" updated successfully`
        };
    }
};

export const list_routines: Tool = {
    name: 'list_routines',
    description: 'Get all routines for a user',
    parameters: {
        type: 'object',
        properties: {
            active_only: {
                type: 'boolean',
                description: 'Whether to return only active routines (optional, defaults to false)'
            }
        },
        required: []
    },
    execute: async (args: { userId: string; active_only?: boolean }) => {
        const userId = parseInt(args.userId);
        const activeOnly = args.active_only ?? false;

        const allRoutines = await getAllRoutines(userId);
        const filteredRoutines = activeOnly ? allRoutines.filter(routine => routine.isActive) : allRoutines;

        return {
            routines: filteredRoutines,
            count: filteredRoutines.length,
            total_count: allRoutines.length,
            active_count: allRoutines.filter(routine => routine.isActive).length
        };
    }
};

export const get_routine_by_id: Tool = {
    name: 'get_routine_by_id',
    description: 'Get a single routine by its ID',
    parameters: {
        type: 'object',
        properties: {
            routine_id: {
                type: 'string',
                description: 'The ID of the routine to retrieve'
            }
        },
        required: ['routine_id']
    },
    execute: async (args: { userId: string; routine_id: string }) => {
        const userId = parseInt(args.userId);
        const routineId = args.routine_id;

        const routine = await getRoutine(userId, routineId);
        if (!routine) {
            throw new Error(`Routine with ID ${routineId} not found`);
        }

        return {
            routine: routine
        };
    }
}; 