export type ErpCustomer = {
  idprogramitems: number;
  idbranch: number;
  idperson: number;
  fperson: string;
  ftel1?: string;
  ftel2?: string;
  ftel3?: string;
  ftel4?: string;
  fbranch?: string;
};
export type ErpBranch = {
  idprogramitems: number;
  idbranch: number;
  fbranch: string;
  fvis?: boolean;
  deleted?: boolean;
};
export type SourceSnapshot = {
  customers: ErpCustomer[];
  branches: ErpBranch[];
  label: string;
  identity: string;
};
export const confirmedBranchIds = [39, 40, 41, 42, 45, 51, 56, 57, 60];
export type CompanySettings = {
  distributionMode: "per_branch" | "global";
  globalGroupId?: string | null;
  globalGroupTitle?: string | null;
  globalBaseName?: string;
  globalNextCounter?: number;
  historicalDailyLimit: number;
  historicalLimitScope: "total" | "per_branch";
  rolloverThreshold: number;
  workStart: string;
  workEnd: string;
  additionMinIntervalSeconds: number;
  additionDailyLimit: number;
  inviteOnPrivacy?: boolean;
  inviteTemplate?: string;
  additionOnlyMode?: boolean;
};
export const defaultSettings: CompanySettings = {
  distributionMode: "per_branch",
  globalGroupId: null,
  globalGroupTitle: null,
  historicalDailyLimit: 0,
  historicalLimitScope: "total",
  rolloverThreshold: 950,
  workStart: "09:00",
  workEnd: "21:00",
  additionMinIntervalSeconds: 60,
  additionDailyLimit: 100,
};
export const whatsappLabels: Record<string, string> = {
  unchecked: "لم يُفحص",
  registered: "لديه واتساب",
  not_registered: "بدون واتساب",
  unknown: "تعذّر الفحص",
};
export const membershipLabels: Record<string, string> = {
  not_attempted: "لم تبدأ الإضافة",
  joined: "انضم وتأكدت العضوية",
  already_member: "عضو بالفعل",
  invitation_sent: "أُرسلت دعوة",
  pending: "بانتظار التأكيد",
  review: "تحتاج مراجعة",
};
