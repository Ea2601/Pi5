// expo-contacts önizleme sahtesi: izin verilmiş, rehber boş
export const ContactField = {
  IS_FAVOURITE: 'isFavourite', GIVEN_NAME: 'givenName', MIDDLE_NAME: 'middleName', FAMILY_NAME: 'familyName', NICKNAME: 'nickname',
  PREFIX: 'prefix', SUFFIX: 'suffix', COMPANY: 'company', DEPARTMENT: 'department', JOB_TITLE: 'jobTitle', NOTE: 'note',
  BIRTHDAY: 'birthday', EMAILS: 'emails', PHONES: 'phones', ADDRESSES: 'addresses', DATES: 'dates', URL_ADDRESSES: 'urlAddresses',
  RELATIONS: 'relations', EXTRA_NAMES: 'extraNames',
} as const;
export class Contact {
  static async getAllDetails() { return []; }
  static async create() { return new Contact(); }
}
const granted = { granted: true, status: 'granted', canAskAgain: true, expires: 'never' };
export async function getPermissionsAsync() { return granted; }
export async function requestPermissionsAsync() { return granted; }
