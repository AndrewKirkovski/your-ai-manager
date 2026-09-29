import { Tool } from './tool.types';
import { geocode, isGoogleMapsConfigured } from './googleMapsService';
import { saveUserAddress, getUserAddresses, deleteUserAddress } from './userStore';
import { textify } from './telegramFormat';

export const SaveAddress: Tool = {
    name: 'SaveAddress',
    description: 'Save a named address for the user (e.g., home, work, gym, friend name). Geocodes a street address or saves a shared Telegram location. Smart LuxMed booking needs separate street-address verification.',
    parameters: {
        type: 'object',
        properties: {
            label: { type: 'string', description: 'Address label, e.g. "home", "work", "gym", "zapaven". Lowercase.' },
            address: { type: 'string', description: 'Full address to geocode, e.g. "ul. Marszałkowska 1, Warszawa"' },
            lat: { type: 'number', description: 'Latitude from a shared Telegram location, without address text' },
            lng: { type: 'number', description: 'Longitude from a shared Telegram location, without address text' },
        },
        required: ['label'],
    },
    execute: async (args: { userId: number; label: string; address?: string; lat?: number; lng?: number }) => {
        const label = textify(args.label);
        const rawAddress = textify(args.address);
        if (args.lat != null || args.lng != null) {
            if (args.lat == null || args.lng == null || rawAddress || !Number.isFinite(args.lat) || !Number.isFinite(args.lng)
                || Math.abs(args.lat) > 90 || Math.abs(args.lng) > 180)
                return { success: false, message: 'Provide either a street address or valid coordinates from a shared location, not both.' };
            const address = `${args.lat.toFixed(4)}, ${args.lng.toFixed(4)}`;
            saveUserAddress(args.userId, label, address, args.lat, args.lng);
            return { success: true, message: `Location "${label}" saved: ${address}. Confirm a street address separately for smart LuxMed booking.` };
        }

        if (!rawAddress) {
            return { success: false, message: 'Provide either an address string or lat/lng coordinates.' };
        }

        if (!isGoogleMapsConfigured()) {
            return { success: false, message: 'Google Maps API key not configured — cannot geocode address.' };
        }

        const place = await geocode(rawAddress);
        if (!place) {
            return { success: false, message: `Could not find location: "${rawAddress}". Try a more specific address.` };
        }

        const requested = rawAddress.toLocaleLowerCase('pl-PL');
        const resolved = place.formattedAddress.toLocaleLowerCase('pl-PL');
        const requestedNumber = requested.match(/(?:^|\s)(\d+[a-z]?)\b/);
        if (requestedNumber) {
            const exactNumber = requestedNumber[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const numberPattern = new RegExp(`(?:^|[^\\d])${exactNumber}(?=$|[^\\d])`);
            if (!numberPattern.test(resolved)) {
                return {
                    success: false,
                    message: `Google resolved "${rawAddress}" to "${place.formattedAddress}". Please confirm the building number and try again.`,
                };
            }
        }
        const requestedStreet = requested
            .split(',')[0]
            .replace(/\b\d+[a-z]?\b/, '')
            .replace(/^\s*(ul\.?|al\.?|aleja|plac|pl\.?)\s+/i, '')
            .trim();
        if (requestedStreet && !resolved.includes(requestedStreet)) {
            return {
                success: false,
                message: `Google resolved "${rawAddress}" to "${place.formattedAddress}". Please confirm the street and try again.`,
            };
        }
        if (requested.includes('warszaw') && !resolved.includes('warszaw')) {
            return {
                success: false,
                message: `Google resolved "${rawAddress}" outside Warszawa as "${place.formattedAddress}". Please provide the city explicitly.`,
            };
        }

        saveUserAddress(args.userId, label, place.formattedAddress, place.lat, place.lng);
        console.log(`[Address] Saved "${label}" for user ${args.userId}: ${place.formattedAddress} (${place.lat}, ${place.lng})`);
        return { success: true, message: `Address "${label}" saved: ${place.formattedAddress}` };
    },
};

export const ListAddresses: Tool = {
    name: 'ListAddresses',
    description: 'List all saved addresses for the user.',
    parameters: {
        type: 'object',
        properties: {},
    },
    execute: async (args: { userId: number }) => {
        const addresses = getUserAddresses(args.userId);
        if (addresses.length === 0) {
            return { success: true, message: 'No saved addresses.', addresses: [] };
        }
        return {
            success: true,
            addresses: addresses.map(a => ({
                label: a.label,
                address: a.address,
            })),
        };
    },
};

export const DeleteAddress: Tool = {
    name: 'DeleteAddress',
    description: 'Remove a saved address by label.',
    parameters: {
        type: 'object',
        properties: {
            label: { type: 'string', description: 'Address label to delete (e.g. "work")' },
        },
        required: ['label'],
    },
    execute: async (args: { userId: number; label: string }) => {
        // Same lookup-symmetry concern as memory: saved label is textified, so
        // lookup key must be too — otherwise markup in the arg would miss.
        const label = textify(args.label);
        deleteUserAddress(args.userId, label);
        return { success: true, message: `Address "${label}" deleted.` };
    },
};
