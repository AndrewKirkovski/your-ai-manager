import * as chrono from 'chrono-node';
import { CronExpressionParser } from 'cron-parser';
import { v4 as uuidv4 } from 'uuid';
import { ReminderSchedule } from './userStore';

export class ReminderService {
    /**
     * Parse natural language into a reminder schedule
     */
    static parseReminderText(humanText: string, reminderText: string): ReminderSchedule | null {
        const reminder: ReminderSchedule = {
            id: uuidv4(),
            humanText: humanText.toLowerCase(),
            reminderText,
            isActive: true,
            createdAt: new Date()
        };

        // Try to parse as cron expression first
        if (this.isValidCronExpression(humanText)) {
            reminder.cronExpression = humanText;
            reminder.nextFireTime = this.getNextCronExecution(humanText);
            return reminder;
        }

        // Try parsing common patterns
        const cronExpression = this.parseCommonPatterns(humanText);
        if (cronExpression) {
            reminder.cronExpression = cronExpression;
            reminder.nextFireTime = this.getNextCronExecution(cronExpression);
            return reminder;
        }

        // Try chrono-node for specific dates/times
        const parsed = chrono.parseDate(humanText);
        if (parsed && parsed > new Date()) {
            // For one-time reminders, we'll check every minute if it's time
            reminder.nextFireTime = parsed;
            return reminder;
        }

        return null;
    }

    /**
     * Create a reminder directly from a cron expression (for AI commands)
     */
    static createReminderFromCron(cronExpression: string, reminderText: string): ReminderSchedule | null {
        if (!this.isValidCronExpression(cronExpression)) {
            return null;
        }

        const nextFireTime = this.getNextCronExecution(cronExpression);
        if (!nextFireTime) {
            return null;
        }

        return {
            id: uuidv4(),
            humanText: this.cronToHumanText(cronExpression),
            cronExpression,
            reminderText,
            nextFireTime,
            isActive: true,
            createdAt: new Date()
        };
    }

    /**
     * Create a one-time reminder from a timestamp (for AI commands)
     */
    static createReminderFromTimestamp(timestamp: string, reminderText: string): ReminderSchedule | null {
        try {
            const fireTime = new Date(timestamp);
            const now = new Date();
            
            // Check if timestamp is valid and in the future
            if (isNaN(fireTime.getTime()) || fireTime <= now) {
                return null;
            }

            return {
                id: uuidv4(),
                humanText: `one-time at ${fireTime.toLocaleString()}`,
                reminderText,
                nextFireTime: fireTime,
                isActive: true,
                createdAt: now
                // No cronExpression for one-time reminders
            };
        } catch (error) {
            console.error('Error creating reminder from timestamp:', error);
            return null;
        }
    }

    /**
     * Convert cron expression to human-readable text
     */
    static cronToHumanText(cronExpression: string): string {
        const parts = cronExpression.split(' ');
        if (parts.length !== 5) return cronExpression;

        const [minute, hour, day, month, dayOfWeek] = parts;

        // Daily pattern
        if (day === '*' && month === '*' && dayOfWeek === '*') {
            const hourNum = parseInt(hour);
            const minNum = parseInt(minute);
            const time = `${hourNum.toString().padStart(2, '0')}:${minNum.toString().padStart(2, '0')}`;
            return `daily at ${time}`;
        }

        // Weekly pattern
        if (day === '*' && month === '*' && dayOfWeek !== '*') {
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const hourNum = parseInt(hour);
            const minNum = parseInt(minute);
            const time = `${hourNum.toString().padStart(2, '0')}:${minNum.toString().padStart(2, '0')}`;
            
            if (dayOfWeek.includes('-') && dayOfWeek === '1-5') {
                return `workdays at ${time}`;
            } else if (dayOfWeek.includes(',')) {
                const dayNums = dayOfWeek.split(',').map(d => parseInt(d));
                const dayNames = dayNums.map(d => days[d]).join(', ');
                return `${dayNames} at ${time}`;
            } else {
                const dayName = days[parseInt(dayOfWeek)];
                return `every ${dayName} at ${time}`;
            }
        }

        // Fallback to cron expression
        return cronExpression;
    }

    /**
     * Check if string is valid cron expression
     */
    static isValidCronExpression(expression: string): boolean {
        try {
            CronExpressionParser.parse(expression);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get next execution time for cron expression
     */
    static getNextCronExecution(cronExpression: string): Date | undefined {
        try {
            const interval = CronExpressionParser.parse(cronExpression);
            return interval.next().toDate();
        } catch {
            return undefined;
        }
    }

    /**
     * Parse common human-readable patterns into cron expressions
     */
    static parseCommonPatterns(text: string): string | null {
        const lowerText = text.toLowerCase().trim();

        // Daily patterns
        if (lowerText.match(/^(daily|every day)(\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/)) {
            const timeMatch = lowerText.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
            if (timeMatch) {
                let hour = parseInt(timeMatch[1]);
                const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
                const period = timeMatch[3];
                
                if (period === 'pm' && hour !== 12) hour += 12;
                if (period === 'am' && hour === 12) hour = 0;
                
                return `${minute} ${hour} * * *`;
            }
            return '0 9 * * *'; // Default 9 AM
        }

        // Weekly patterns
        const weeklyMatch = lowerText.match(/^(every\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/);
        if (weeklyMatch) {
            const days = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
            const day = days[weeklyMatch[2] as keyof typeof days];
            
            let hour = 9, minute = 0; // Default 9 AM
            if (weeklyMatch[4]) {
                hour = parseInt(weeklyMatch[4]);
                minute = weeklyMatch[5] ? parseInt(weeklyMatch[5]) : 0;
                const period = weeklyMatch[6];
                
                if (period === 'pm' && hour !== 12) hour += 12;
                if (period === 'am' && hour === 12) hour = 0;
            }
            
            return `${minute} ${hour} * * ${day}`;
        }

        // Hourly patterns
        if (lowerText.match(/^(every\s+hour|hourly)/)) {
            return '0 * * * *';
        }

        // Morning/evening patterns
        if (lowerText.match(/^(every\s+)?(morning)/)) {
            return '0 9 * * *'; // 9 AM daily
        }
        if (lowerText.match(/^(every\s+)?(evening)/)) {
            return '0 18 * * *'; // 6 PM daily
        }

        // Workday patterns
        if (lowerText.match(/^(workdays?|weekdays?)(\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/)) {
            const timeMatch = lowerText.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
            let hour = 9, minute = 0; // Default 9 AM
            
            if (timeMatch) {
                hour = parseInt(timeMatch[1]);
                minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
                const period = timeMatch[3];
                
                if (period === 'pm' && hour !== 12) hour += 12;
                if (period === 'am' && hour === 12) hour = 0;
            }
            
            return `${minute} ${hour} * * 1-5`; // Monday to Friday
        }

        return null;
    }

    /**
     * Check if a reminder should fire now
     */
    static shouldFireReminder(reminder: ReminderSchedule, now: Date = new Date()): boolean {
        if (!reminder.isActive || !reminder.nextFireTime) {
            return false;
        }

        // For cron-based reminders, check if next fire time has passed
        if (reminder.cronExpression) {
            return reminder.nextFireTime <= now;
        }

        // For one-time reminders, check if time has passed (with 1-minute tolerance)
        const timeDiff = Math.abs(now.getTime() - reminder.nextFireTime.getTime());
        return timeDiff <= 60000; // 1 minute tolerance
    }

    /**
     * Update next fire time for recurring reminders
     */
    static updateNextFireTime(reminder: ReminderSchedule): Date | undefined {
        if (!reminder.cronExpression) {
            // One-time reminder, deactivate after firing
            reminder.isActive = false;
            return undefined;
        }

        // Recurring reminder, calculate next execution
        return this.getNextCronExecution(reminder.cronExpression);
    }

    /**
     * Get human-readable examples for help
     */
    static getExamples(): string[] {
        return [
            'daily at 9am',
            'every Monday at 2pm',
            'workdays at 10:30am',
            'every evening',
            'every hour',
            'December 25th at noon',
            'tomorrow at 3pm',
            '0 9 * * 1-5' // Cron example
        ];
    }
} 