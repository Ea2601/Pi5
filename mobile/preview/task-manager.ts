// expo-task-manager önizleme sahtesi
export function defineTask() {}
export async function isTaskRegisteredAsync() { return false; }
export async function getRegisteredTasksAsync(): Promise<{ taskName: string; taskType: string; options: any }[]> { return []; }
