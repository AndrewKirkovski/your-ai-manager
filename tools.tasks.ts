// Define the GetTaskById tool
import {Tool} from "./tool.types";
import {
    addUserTask,
    generateShortId,
    getAllTasks,
    getRoutine,
    getTask,
    Task,
    TaskStatus,
    updateUserRoutine,
    updateUserTask,
    removeUserTask
} from "./userStore";

export const GetTaskById: Tool = {
    name: 'GetTaskById',
    description: 'Get a single task by its ID',
    parameters: {
        type: 'object',
        properties: {
            task_id: {
                type: 'string',
                description: 'The ID of the task to retrieve'
            }
        },
        required: ['task_id']
    },
    execute: async (args: { userId: string; task_id: string }) => {
        const userId = parseInt(args.userId);
        const taskId = args.task_id;

        const task = await getTask(userId, taskId);
        if (!task) {
            throw new Error(`Task with ID ${taskId} not found`);
        }

        return {
            task: task
        };
    }
};

export const GetTasksByIdList: Tool = {
    name: 'GetTasksByIdList',
    description: 'Get multiple tasks by their IDs',
    parameters: {
        type: 'object',
        properties: {
            task_ids: {
                type: 'array',
                items: {
                    type: 'string'
                },
                description: 'Array of task IDs to retrieve'
            }
        },
        required: ['task_ids']
    },
    execute: async (args: { userId: string; task_ids: string[] }) => {
        const userId = parseInt(args.userId);
        const taskIds = args.task_ids;

        const allTasks = await getAllTasks(userId);
        const requestedTasks = allTasks.filter(task => taskIds.includes(task.id));

        const foundIds = requestedTasks.map(task => task.id);
        const missingIds = taskIds.filter(id => !foundIds.includes(id));

        return {
            tasks: requestedTasks,
            count: requestedTasks.length,
            found_ids: foundIds,
            missing_ids: missingIds
        };
    }
};

export const AddTask: Tool = {
    name: 'AddTask',
    description: 'Create a new task',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'The name/title of the task'
            },
            routine_id: {
                type: 'string',
                description: 'The ID of the routine this task belongs to (optional)'
            },
            due_at: {
                type: 'string',
                description: 'The due date for the task in ISO format (optional)',
                format: 'date-time'
            },
            ping_at: {
                type: 'string',
                description: 'When to ping/remind about this task in ISO format',
                format: 'date-time'
            },
            annoyance: {
                type: 'string',
                description: 'The annoyance level for the task',
                enum: ['low', 'med', 'high']
            },
            requires_action: {
                type: 'boolean',
                description: 'Whether the task requires action from user'
            }
        },
        required: ['name', 'ping_at']
    },
    execute: async (args: {
        userId: string;
        name: string;
        routine_id?: string;
        due_at?: string;
        ping_at: string;
        annoyance?: string;
        requires_action?: boolean;
    }) => {
        const userId = parseInt(args.userId);

        // Validate annoyance level if provided
        if (args.annoyance && !['low', 'med', 'high'].includes(args.annoyance)) {
            throw new Error(`Invalid annoyance level: ${args.annoyance}. Must be one of: low, med, high`);
        }

        const newTask: Task = {
            id: generateShortId(),
            name: args.name,
            routineId: args.routine_id,
            dueAt: args.due_at ? new Date(args.due_at) : undefined,
            pingAt: new Date(args.ping_at),
            requiresAction: args.requires_action ?? false,
            status: 'pending',
            annoyance: (args.annoyance as 'low' | 'med' | 'high') || 'low',
            postponeCount: 0,
            createdAt: new Date()
        };

        await addUserTask(userId, newTask);

        return {
            success: true,
            task: newTask,
            message: `Task "${newTask.name}" created successfully`
        };
    }
};

export const GetTasksByStatus: Tool = {
    name: 'GetTasksByStatus',
    description: 'Fetch all tasks filtered by status (defaults to pending if not specified)',
    parameters: {
        type: 'object',
        properties: {
            status: {
                type: 'string',
                description: 'The status to filter tasks by (e.g., "pending", "completed", "failed", "needs_replanning"). Defaults to "pending" if not specified.',
                enum: ['pending', 'completed', 'failed', 'needs_replanning']
            }
        },
        required: []
    },
    execute: async (args: { userId: string; status?: string }) => {
        const userId = parseInt(args.userId);
        const status = (args.status as TaskStatus) || 'pending';

        // Validate status
        if (!['pending', 'completed', 'failed', "needs_replanning"].includes(status)) {
            throw new Error(`Invalid status: ${status}. Must be one of: pending, completed, failed`);
        }

        const allTasks = await getAllTasks(userId);
        const filteredTasks = allTasks.filter(task => task.status === status);

        return {
            tasks: filteredTasks,
            count: filteredTasks.length,
            status: status
        };
    }
};

export const UpdateTask: Tool = {
    name: 'UpdateTask',
    description: 'Update a single existing task with new information',
    parameters: {
        type: 'object',
        properties: {
            task_id: {
                type: 'string',
                description: 'The ID of the task to update'
            },
            name: {
                type: 'string',
                description: 'The new name for the task'
            },
            status: {
                type: 'string',
                description: 'The new status for the task',
                enum: ['pending', 'completed', 'failed', 'needs_replanning']
            },
            annoyance: {
                type: 'string',
                description: 'The new annoyance level for the task',
                enum: ['low', 'med', 'high']
            },
            due_at: {
                type: 'string',
                description: 'The new deadline date for the task in ISO format',
                format: 'date-time'
            },
            ping_at: {
                type: 'string',
                description: 'The next time system will trigger task / ping user',
                format: 'date-time'
            },
            requires_action: {
                type: 'boolean',
                description: 'Whether the task requires action'
            }
        },
        required: ['task_id']
    },
    execute: async (args: {
        userId: string;
        task_id: string;
        name?: string;
        status?: string;
        annoyance?: string;
        due_at?: string;
        ping_at?: string;
        requires_action?: boolean;
    }) => {
        const userId = parseInt(args.userId);
        const taskId = args.task_id;

        // Validate status if provided
        if (args.status && !['pending', 'completed', 'failed', 'needs_replanning'].includes(args.status)) {
            throw new Error(`Invalid status: ${args.status}. Must be one of: pending, completed, failed, needs_replanning`);
        }

        // Validate annoyance level if provided
        if (args.annoyance && !['low', 'med', 'high'].includes(args.annoyance)) {
            throw new Error(`Invalid annoyance level: ${args.annoyance}. Must be one of: low, med, high`);
        }

        // Check if task exists
        const existingTask = await getTask(userId, taskId);
        if (!existingTask) {
            throw new Error(`Task with ID ${taskId} not found`);
        }

        // Update the task
        await updateUserTask(userId, taskId, (task) => {
            if (args.name !== undefined) task.name = args.name;
            if (args.status !== undefined) task.status = args.status as TaskStatus;
            if (args.annoyance !== undefined) task.annoyance = args.annoyance as 'low' | 'med' | 'high';
            if (args.due_at !== undefined) {
                task.dueAt = args.due_at ? new Date(args.due_at) : undefined;
            }
            if (args.ping_at !== undefined) {
                task.pingAt = args.ping_at ? new Date(args.ping_at) : task.pingAt;
                task.status = 'pending'; // Reset status to pending if ping_at is updated
            }
            if (args.requires_action !== undefined) task.requiresAction = args.requires_action;
            if (args.due_at) {
                task.postponeCount = (task.postponeCount ?? 0) + 1;
            }
        });

        // Get the updated task
        const updatedTask = await getTask(userId, taskId);

        return {
            success: true,
            task: updatedTask,
            message: `Task "${updatedTask?.name}" updated successfully`
        };
    }
};

export const MarkTaskComplete: Tool = {
    name: 'MarkTaskComplete',
    description: 'Mark a task as completed and update routine stats if applicable',
    parameters: {
        type: 'object',
        properties: {
            task_id: {
                type: 'string',
                description: 'The ID of the task to mark as completed'
            }
        },
        required: ['task_id']
    },
    execute: async (args: { userId: string; task_id: string }) => {
        const userId = parseInt(args.userId);
        const taskId = args.task_id;

        // Check if task exists
        const existingTask = await getTask(userId, taskId);
        if (!existingTask) {
            throw new Error(`Task with ID ${taskId} not found`);
        }

        // Update the task status to completed
        await updateUserTask(userId, taskId, (task) => {
            task.status = 'completed';
        });

        // If task has a routineId, update routine stats
        if (existingTask.routineId) {
            await updateUserRoutine(userId, existingTask.routineId, (routine) => {
                routine.stats.completed += 1;
            });
        }

        // Get the updated task
        const updatedTask = await getTask(userId, taskId);

        return {
            success: true,
            task: updatedTask,
            routineUpdated: !!existingTask.routineId,
            message: `Task "${updatedTask?.name}" marked as completed${existingTask.routineId ? ' and routine stats updated' : ''}`
        };
    }
};

export const MarkTaskFailed: Tool = {
    name: 'MarkTaskFailed',
    description: 'Mark a task as failed and update routine stats if applicable',
    parameters: {
        type: 'object',
        properties: {
            task_id: {
                type: 'string',
                description: 'The ID of the task to mark as failed'
            }
        },
        required: ['task_id']
    },
    execute: async (args: { userId: string; task_id: string }) => {
        const userId = parseInt(args.userId);
        const taskId = args.task_id;

        // Check if task exists
        const existingTask = await getTask(userId, taskId);
        if (!existingTask) {
            throw new Error(`Task with ID ${taskId} not found`);
        }

        // Update the task status to failed
        await updateUserTask(userId, taskId, (task) => {
            task.status = 'failed';
        });

        // If task has a routineId, update routine stats
        if (existingTask.routineId) {
            await updateUserRoutine(userId, existingTask.routineId, (routine) => {
                routine.stats.failed += 1;
            });
        }

        // Get the updated task
        const updatedTask = await getTask(userId, taskId);

        return {
            success: true,
            task: updatedTask,
            routineUpdated: !!existingTask.routineId,
            message: `Task "${updatedTask?.name}" marked as failed${existingTask.routineId ? ' and routine stats updated' : ''}`
        };
    }
};

export const DeleteTask: Tool = {
    name: 'DeleteTask',
    description: 'Delete a task by its ID',
    parameters: {
        type: 'object',
        properties: {
            task_id: {
                type: 'string',
                description: 'The ID of the task to delete'
            }
        },
        required: ['task_id']
    },
    execute: async (args: { userId: string; task_id: string }) => {
        const userId = parseInt(args.userId);
        const taskId = args.task_id;

        // Check if task exists
        const existingTask = await getTask(userId, taskId);
        if (!existingTask) {
            throw new Error(`Task with ID ${taskId} not found`);
        }

        // Delete the task
        await removeUserTask(userId, taskId);

        return {
            success: true,
            deleted_task: existingTask,
            message: `Task "${existingTask.name}" deleted successfully`
        };
    }
};

export const GetTasksByRoutine: Tool = {
    name: 'GetTasksByRoutine',
    description: 'Fetch all tasks for a specific routine',
    parameters: {
        type: 'object',
        properties: {
            routine_id: {
                type: 'string',
                description: 'The ID of the routine to get tasks for'
            }
        },
        required: ['routine_id']
    },
    execute: async (args: { userId: string; routine_id: string }) => {
        const userId = parseInt(args.userId);
        const routineId = args.routine_id;

        const allTasks = await getAllTasks(userId);
        const routine = await getRoutine(userId, routineId);
        const routineTasks = allTasks.filter(task => task.routineId === routineId);

        return {
            tasks: routineTasks,
            routine: routine || null,
            count: routineTasks.length,
        };
    }
};