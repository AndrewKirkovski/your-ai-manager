import { createHash } from 'node:crypto';
import type { LuxmedCity, LuxmedDoctor, LuxmedService } from './luxmedAdapter';

export function providerIdentityFingerprint(serviceId: number, serviceName: string, cityId: number,
    cityName: string, doctorNames: ReadonlyMap<number, string>): string {
    return createHash('sha256').update(JSON.stringify([serviceId, serviceName, cityId, cityName, [...doctorNames]])).digest('hex');
}

export function uniqueServiceName(services: LuxmedService[], id: number): string | null {
    if (!Number.isSafeInteger(id) || id <= 0 || !Array.isArray(services)) return null;
    const found: string[] = [];
    const visit = (items: LuxmedService[]): void => {
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            if (item.id === id) found.push(typeof item.name === 'string' ? item.name.trim() : '');
            if (Array.isArray(item.children)) visit(item.children);
        }
    };
    visit(services);
    return found.length === 1 && found[0] ? found[0] : null;
}

export function uniqueCityName(cities: LuxmedCity[], id: number): string | null {
    if (!Number.isSafeInteger(id) || id <= 0 || !Array.isArray(cities)) return null;
    const found = cities.filter(city => city?.id === id);
    const name = typeof found[0]?.name === 'string' ? found[0].name.trim() : '';
    return found.length === 1 && name ? name : null;
}

export function selectedDoctorNames(doctors: LuxmedDoctor[], ids: number[] | null): Map<number, string> | null {
    const names = new Map<number, string>();
    if (ids === null) return names;
    if (!Array.isArray(ids) || !ids.length || !Array.isArray(doctors)) return null;
    for (const id of ids) {
        if (!Number.isSafeInteger(id) || id <= 0 || names.has(id)) return null;
        const found = doctors.filter(doctor => doctor?.id === id);
        const name = typeof found[0]?.name === 'string' ? found[0].name.trim() : '';
        if (found.length !== 1 || !name) return null;
        names.set(id, name);
    }
    return names;
}
