import { DateTime } from 'luxon';
import cronstrue from 'cronstrue';
import 'cronstrue/locales/ru';

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
 * Format a date with no relative words, for text that gets stored. "сегодня"
 * written into a stored row keeps meaning that day long after it has passed.
 */
export function formatDateAbsolute(date: Date | string, timezone: string = DEFAULT_TIMEZONE): string {
    const dt = typeof date === 'string' ? DateTime.fromISO(date) : DateTime.fromJSDate(date);
    return dt.setZone(timezone).setLocale('ru').toFormat('d MMMM yyyy, HH:mm');
}

/**
 * Format a date as local ISO with its offset, e.g. 2026-10-26T13:29+01:00. The
 * model mistook bare UTC times for Warsaw time, so every time it reads says which
 * offset it is in, and it can copy this form into ping_at.
 */
export function formatDateWithOffset(date: Date | string, timezone: string = DEFAULT_TIMEZONE): string {
    const dt = typeof date === 'string' ? DateTime.fromISO(date) : DateTime.fromJSDate(date);
    return dt.setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mmZZ");
}

/** The Now line of the per-turn context: the model's only source for today's date. */
export function formatNowForPrompt(now: Date = new Date(), timezone: string = DEFAULT_TIMEZONE): string {
    const dt = DateTime.fromJSDate(now).setZone(timezone).setLocale('ru');
    return `Now: ${dt.toFormat('cccc, d MMMM yyyy, HH:mm')} (${formatDateWithOffset(now, timezone)}, ${timezone})`;
}

type RelativeWord = 'сегодня' | 'завтра' | 'вчера';

const RELATIVE_WORD_REWRITES: Record<RelativeWord, string> = {
    сегодня: 'в тот день',
    завтра: 'на следующий день',
    вчера: 'накануне',
};

/** Prepositions need their own forms: a plain rewrite gives "на на следующий день". */
const RELATIVE_WORD_PREPOSITION_REWRITES: Record<string, Record<RelativeWord, string>> = {
    на: { сегодня: 'на тот день', завтра: 'на следующий день', вчера: 'на предыдущий день' },
    за: { сегодня: 'за тот день', завтра: 'за следующий день', вчера: 'за предыдущий день' },
    до: { сегодня: 'до того дня', завтра: 'до следующего дня', вчера: 'до предыдущего дня' },
    с: { сегодня: 'с того дня', завтра: 'со следующего дня', вчера: 'с предыдущего дня' },
    со: { сегодня: 'с того дня', завтра: 'со следующего дня', вчера: 'с предыдущего дня' },
    к: { сегодня: 'к тому дню', завтра: 'к следующему дню', вчера: 'к предыдущему дню' },
};

// \b does not work on Cyrillic in JavaScript, so a pattern using it would match
// nothing. These also keep сегодняшний, завтрак, послезавтра and сегодня-завтра.
const NOT_AFTER_WORD = '(?<![\\p{L}\\p{N}_-])';
const NOT_BEFORE_WORD = '(?![\\p{L}\\p{N}_-])';
const PROTECTED_SPANS = [
    '«[^»]*»', '"[^"\\n]*"', '„[^“\\n]*“', '`[^`]*`', '<[^>\\n]*>', 'https?://\\S+',
    '^(?:\\[Tool:|Input:|Output:|Error:|Blocked:).*$',
].join('|');
const RELATIVE_WORD = `${NOT_AFTER_WORD}(?:(?<prep>на|за|до|со|с|к|по|от|для|про|после)\\s+)?(?<word>сегодня|завтра|вчера)(?<same>\\s+же)?${NOT_BEFORE_WORD}`;
const RELATIVE_DATE_PATTERN = new RegExp(`${PROTECTED_SPANS}|${RELATIVE_WORD}`, 'gimu');
const RELATIVE_WORD_ANYWHERE = new RegExp(`${NOT_AFTER_WORD}(?:сегодня|завтра|вчера)${NOT_BEFORE_WORD}`, 'iu');

function matchLetterCase(original: string, replacement: string): string {
    if (original.length > 1 && original === original.toUpperCase()) return replacement.toUpperCase();
    if (original[0] !== original[0].toLowerCase()) return replacement[0].toUpperCase() + replacement.slice(1);
    return replacement;
}

/**
 * Rewrite сегодня, вчера and завтра in stored text so they no longer claim to mean
 * the day the text is read. Each row carries its own date prefix, so "в тот день"
 * stays true. Protected spans (quotes, tags, tool lines) stay as written.
 * `onSkip` receives each span that still holds a relative word, for reporting.
 */
export function neutralizeRelativeDates(text: string, onSkip?: (kept: string) => void): string {
    return text.replace(RELATIVE_DATE_PATTERN, (match, ...args) => {
        const groups = args[args.length - 1] as { prep?: string; word?: string; same?: string };
        if (!groups.word) {
            if (RELATIVE_WORD_ANYWHERE.test(match)) onSkip?.(match);
            return match;
        }
        const word = groups.word.toLowerCase() as RelativeWord;
        const prep = groups.prep?.toLowerCase();
        if (!prep) {
            if (word === 'сегодня' && groups.same) return matchLetterCase(match, 'в тот же день');
            return matchLetterCase(match, RELATIVE_WORD_REWRITES[word]) + (groups.same ?? '');
        }
        const rewrite = RELATIVE_WORD_PREPOSITION_REWRITES[prep]?.[word];
        if (!rewrite) {
            onSkip?.(match);
            return match;
        }
        return matchLetterCase(match, rewrite) + (groups.same ?? '');
    });
}

const COMPACTED_ROW_PREFIX = '<system>Compacted summary of ';
const COMPACTED_ROW_WRAPPER_END = '</system>\n';

/**
 * One stored summary row with its body rewritten and its wrapper byte-identical,
 * or null when the row is not a summary row. Never call stripSystemTags here: it
 * removes the wrapper along with its contents.
 */
export function repairCompactedRow(content: string, onSkip?: (kept: string) => void): string | null {
    if (!content.startsWith(COMPACTED_ROW_PREFIX)) return null;
    const wrapperEnd = content.indexOf(COMPACTED_ROW_WRAPPER_END);
    if (wrapperEnd < 0) return null;
    const bodyStart = wrapperEnd + COMPACTED_ROW_WRAPPER_END.length;
    return content.slice(0, bodyStart) + neutralizeRelativeDates(content.slice(bodyStart), onSkip);
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