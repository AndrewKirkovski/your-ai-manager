import { Tool } from './tool.types';
import { geocode, isGoogleMapsConfigured } from './googleMapsService';
import { saveUserAddress, getUserAddresses, deleteUserAddress } from './userStore';
import { textify } from './telegramFormat';

export const SaveAddress: Tool = {
    name: 'SaveAddress',
    description: 'Save a named address for the user (e.g., home, work, gym, friend name). Geocodes the address automatically. Use when user says "my home is at...", "I live at...", "save address...", or shares a location.',
    parameters: {
        type: 'object',
        properties: {
            label: { type: 'string', description: 'Address label, e.g. "home", "work", "gym", "zapaven". Lowercase.' },
            address: { type: 'string', description: 'Full address to geocode, e.g. "ul. Marszałkowska 1, Warszawa"' },
            lat: { type: 'number', description: 'Latitude (use if user shared Telegram location, skip geocoding)' },
            lng: { type: 'number', description: 'Longitude (use if user shared Telegram location, skip geocoding)' },
        },
        required: ['label'],
    },
    execute: async (args: { userId: number; label: string; address?: string; lat?: number; lng?: number }) => {
        const label = textify(args.label);
        const rawAddress = textify(args.address);
        if (args.lat != null && args.lng != null) {
            const address = rawAddress || `${args.lat.toFixed(4)}, ${args.lng.toFixed(4)}`;
            saveUserAddress(args.userId, label, address, args.lat, args.lng);
            return { success: true, message: `Address "${label}" saved: ${address}` };
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
