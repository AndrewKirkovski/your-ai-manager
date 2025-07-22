import { DateTime } from 'luxon';
import cronstrue from 'cronstrue';
import `cronstrue/locales/ru`;

// Set default timezone to Warsaw (Europe/Warsaw)
const DEFAULT_TIMEZONE = 'Europe/Warsaw';

/**
 * Format date in human-readable Russian format
 * Omits day if it's today/tomorrow and uses "сегодня"/"завтра"
 */
export function formatDateHuman(date: Date | string, timezone: string = DEFAULT_TIMEZONE): string {
    const dt = typeof date === 'string' ? DateTime.fromISO(date) : DateTime.fromJSDate(date);
    const now = DateTime.now().setZone(timezone);
    const tomorrow = now.plus({ days: 1 });
    
    // Set the date to the specified timezone
    const dateInTz = dt.setZone(timezone);
    const nowInTz = now.setZone(timezone);
    const tomorrowInTz = tomorrow.setZone(timezone);
    
    // Check if it's today
    if (dateInTz.hasSame(nowInTz, 'day')) {
        return `сегодня в ${dateInTz.toFormat('HH:mm')}`;
    }
    
    // Check if it's tomorrow
    if (dateInTz.hasSame(tomorrowInTz, 'day')) {
        return `завтра в ${dateInTz.toFormat('HH:mm')}`;
    }
    
    // Check if it's within the next 7 days
    const daysDiff = dateInTz.diff(nowInTz, 'days').days;
    if (daysDiff > 0 && daysDiff <= 7) {
        const dayNames = [
            'понедельник', 'вторник', 'среда', 'четверг', 
            'пятница', 'суббота', 'воскресенье'
        ];
        const dayName = dayNames[dateInTz.weekday - 1];
        return `в ${dayName} в ${dateInTz.toFormat('HH:mm')}`;
    }
    
    // For dates further in the future or past
    return dateInTz.toFormat('dd MMMM в HH:mm', { locale: 'ru' });
}

/**
 * Format date range in human-readable Russian format
 */
export function formatDateRangeHuman(startDate: Date | string, endDate: Date | string, timezone: string = DEFAULT_TIMEZONE): string {
    const start = formatDateHuman(startDate, timezone);
    const end = formatDateHuman(endDate, timezone);
    return `${start} - ${end}`;
}

/**
 * Format relative time in Russian
 */
export function formatRelativeTime(date: Date | string, timezone: string = DEFAULT_TIMEZONE): string {
    const dt = typeof date === 'string' ? DateTime.fromISO(date) : DateTime.fromJSDate(date);
    const now = DateTime.now().setZone(timezone);
    const dateInTz = dt.setZone(timezone);
    const nowInTz = now.setZone(timezone);
    
    const diff = dateInTz.diff(nowInTz);
    const minutes = Math.floor(diff.as('minutes'));
    const hours = Math.floor(diff.as('hours'));
    const days = Math.floor(diff.as('days'));
    
    if (minutes < 0) {
        // Past
        const absMinutes = Math.abs(minutes);
        if (absMinutes < 60) {
            return `${absMinutes} мин. назад`;
        } else if (absMinutes < 1440) {
            const absHours = Math.abs(hours);
            return `${absHours} ч. назад`;
        } else {
            const absDays = Math.abs(days);
            return `${absDays} дн. назад`;
        }
    } else {
        // Future
        if (minutes < 60) {
            return `через ${minutes} мин.`;
        } else if (minutes < 1440) {
            return `через ${hours} ч.`;
        } else {
            return `через ${days} дн.`;
        }
    }
}

/**
 * Convert cron expression to human-readable Russian text
 */
export function formatCronHuman(cronExpression: string): string {
    try {
        // Use cronstrue to get English description
        const englishDescription = cronstrue.toString(cronExpression, { 
            locale: 'ru',
            use24HourTimeFormat: true
         });
        
        // Translate common patterns to Russian
        
        return englishDescription;
    } catch (error) {
        // Fallback to original cron expression if parsing fails
        return cronExpression;
    }
}

/**
 * Format task due time in human-readable format
 */
export function formatTaskDueTime(dueAt: Date | string | null, pingAt: Date | string, timezone: string = DEFAULT_TIMEZONE): string {
    if (dueAt) {
        return formatDateHuman(dueAt, timezone);
    } else {
        return formatDateHuman(pingAt, timezone);
    }
}

/**
 * Get current time in specified timezone
 */
export function getCurrentTime(timezone: string = DEFAULT_TIMEZONE): DateTime {
    return DateTime.now().setZone(timezone);
}

/**
 * Format date for logging (ISO format with timezone)
 */
export function formatDateForLog(date: Date | string, timezone: string = DEFAULT_TIMEZONE): string {
    const dt = typeof date === 'string' ? DateTime.fromISO(date) : DateTime.fromJSDate(date);
    return dt.setZone(timezone).toISO() || dt.setZone(timezone).toString();
} 