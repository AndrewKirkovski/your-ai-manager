import { randomUUID } from 'node:crypto';
import type { Tool } from './tool.types';
import type { Commitment } from './luxmedAvailability';
import { smartStore } from './luxmedSmartStore';
import { requireCurrentAvailabilityTurn } from './luxmedConversation';

export const LuxmedSetScheduleAppointment: Tool = {
    name: 'LuxmedSetScheduleAppointment',
    description: 'Mark an actual appointment in the bot schedule as occupied for smart LuxMed booking. Use confirmed start, end and location. The reminder time is separate and never changes this appointment. Ask for missing dates, recurrence or locations before calling. Pass appointment_id to amend an existing entry.',
    parameters: {
        type: 'object',
        properties: {
            appointment_id: { type: 'string', description: 'Existing schedule appointment ID to amend. Omit for a new appointment.' },
            name: { type: 'string', description: 'Short appointment name.' },
            date: { type: 'string', description: 'One-off local date YYYY-MM-DD. Use this or weekdays.' },
            weekdays: { type: 'array', items: { type: 'number' }, description: 'Recurring weekdays, Monday=1 to Sunday=7. Use this or date.' },
            from: { type: 'string', description: 'Local start time HH:mm in the bot timezone.' },
            to: { type: 'string', description: 'Local end time HH:mm in the bot timezone.' },
            valid_from: { type: 'string', description: 'Optional first recurrence date YYYY-MM-DD.' },
            valid_to: { type: 'string', description: 'Optional last recurrence date YYYY-MM-DD.' },
            except_dates: { type: 'array', items: { type: 'string' }, description: 'Local dates excluded from a recurrence.' },
            location_id: { type: 'string', description: 'Confirmed location ID from LuxmedSaveBookingLocation or address:home.' },
            source_type: { type: 'string', enum: ['task', 'routine'], description: 'Optional existing task or routine link.' },
            source_id: { type: 'string', description: 'ID of the linked task or routine.' },
        },
        required: ['name', 'from', 'to', 'location_id'],
    },
    execute: async (args: {
        userId: number; appointment_id?: string; name: string; date?: string; weekdays?: number[];
        from: string; to: string; valid_from?: string; valid_to?: string;
        except_dates?: string[]; location_id: string; source_type?: 'task' | 'routine'; source_id?: string;
    }) => {
        requireCurrentAvailabilityTurn(args.userId);
        if (Boolean(args.source_type) !== Boolean(args.source_id)) throw new Error('Provide both source_type and source_id for a link.');
        if (args.appointment_id && !smartStore.scheduleAppointments(args.userId).some(a => a.id === args.appointment_id)) {
            throw new Error('Schedule appointment not found. Omit appointment_id to create a new one.');
        }
        const appointment: Commitment = {
            id: args.appointment_id || randomUUID(), name: args.name,
            date: args.date, weekdays: args.weekdays, from: args.from, to: args.to,
            validFrom: args.valid_from, validTo: args.valid_to, exceptDates: args.except_dates,
            locationId: args.location_id,
            source: args.source_type && args.source_id ? { type: args.source_type, id: args.source_id } : undefined,
        };
        const saved = smartStore.setScheduleAppointment(args.userId, appointment);
        return { success: true, appointment: saved, availability_revision: smartStore.policy(args.userId)?.revision ?? null,
            message: `Appointment ${saved.name} is marked as occupied. Reminder times remain separate. Review and confirm availability again before automatic booking resumes.` };
    },
};

export const LuxmedListScheduleAppointments: Tool = {
    name: 'LuxmedListScheduleAppointments',
    description: 'List appointments explicitly marked as occupied for smart LuxMed booking. Ordinary tasks and reminder deadlines are not occupied time.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (args: { userId: number }) => ({
        appointments: smartStore.scheduleAppointments(args.userId),
        availability_revision: smartStore.policy(args.userId)?.revision ?? null,
    }),
};

export const LuxmedDeleteScheduleAppointment: Tool = {
    name: 'LuxmedDeleteScheduleAppointment',
    description: 'Remove an explicitly marked schedule appointment from smart LuxMed availability. Removing a reminder does not remove an appointment.',
    parameters: { type: 'object', properties: { appointment_id: { type: 'string' } }, required: ['appointment_id'] },
    execute: async (args: { userId: number; appointment_id: string }) => {
        requireCurrentAvailabilityTurn(args.userId);
        return {
            success: smartStore.deleteScheduleAppointment(args.userId, args.appointment_id),
            availability_revision: smartStore.policy(args.userId)?.revision ?? null,
            message: 'Review and confirm availability again before automatic booking resumes.',
        };
    },
};
