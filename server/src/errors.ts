export const ERROR_CODES = {
  boardAccessRequired: "board_access_required",
  viewerAccessReadOnly: "viewer_access_read_only",
  companyMembershipInactive: "company_membership_inactive",
  agentCrossCompanyAccess: "agent_cross_company_access",
  trustedBrowserOriginRequired: "trusted_browser_origin_required",
  hostnameNotAllowed: "hostname_not_allowed",
} as const;

export class HttpError extends Error {
  status: number;
  details?: unknown;
  code?: string;

  constructor(status: number, message: string, details?: unknown, code?: string) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden", code?: string) {
  return new HttpError(403, message, undefined, code);
}

export function notFound(message = "Not found") {
  return new HttpError(404, message);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}
