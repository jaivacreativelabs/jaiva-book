/**
 * Open Shop / Close Shop for a restaurant. Closing emails the restaurant's report for today and
 * locks billing (bills routes) until the shop is opened again.
 */
import type { ShopStateDTO } from '@rb/shared';
import type { AuthUser } from '../middleware/auth.js';
import type { BranchScope } from '../middleware/scope.js';
import { BranchModel, DraftModel, TableModel } from '../models/index.js';
import { conflict } from '../utils/errors.js';
import { assertAdmin } from '../utils/roles.js';
import { audit } from './audit.service.js';
import { sendBranchReport } from './dailyReport.service.js';

/** What came of the report email, in words for the person who closed the shop. */
const REPORT_MESSAGE: Record<string, string> = {
  'mail not configured': 'Email is not set up on the server yet (SMTP_USER / SMTP_PASS), so no report was sent.',
  'turned off': 'The daily report email is switched off, so no report was sent.',
  'no recipients': 'No email address is set for the daily report, so none was sent.',
};

export async function setShopOpen(actor: AuthUser, scope: BranchScope, open: boolean): Promise<ShopStateDTO> {
  assertAdmin(actor);
  const branchId = scope.branch._id;
  if (open) {
    await BranchModel.updateOne({ _id: branchId }, { $set: { shopOpen: true, shopStateAt: new Date() } });
    await audit(actor, { restaurantId: scope.restaurant._id, branchId, action: 'SHOP_OPENED', entityType: 'Branch', entityId: branchId, summary: 'Opened the shop' });
    return { shopOpen: true };
  }

  // Open table bills could not be billed once the shop is closed (and would miss the report).
  const open_ = await DraftModel.find({ branchId, type: 'TABLE', status: 'ACTIVE' }).select('tableId groupName').lean<{ tableId: unknown; groupName?: string }[]>();
  if (open_.length) {
    const tables = await TableModel.find({ _id: { $in: open_.map((d) => d.tableId) } }).select('label').lean<{ label: string }[]>();
    const labels = [...new Set(tables.map((t) => t.label))];
    throw conflict(
      `${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ` and ${labels.length - 3} more` : ''} still ${open_.length === 1 ? 'has an open bill' : 'have open bills'}. Generate or delete ${open_.length === 1 ? 'it' : 'them'} before closing the shop.`,
      'OPEN_BILLS',
    );
  }
  // Only the tap that closes the shop emails the report (a repeated tap does not send it twice).
  const closed = await BranchModel.updateOne({ _id: branchId, shopOpen: { $ne: false } }, { $set: { shopOpen: false, shopStateAt: new Date() } });
  if (!closed.modifiedCount) return { shopOpen: false };
  const result = await sendBranchReport(branchId, { onClose: true });
  await audit(actor, {
    restaurantId: scope.restaurant._id,
    branchId,
    action: 'SHOP_CLOSED',
    entityType: 'Branch',
    entityId: branchId,
    summary: `Closed the shop – report ${result.status === 'sent' ? `emailed to ${result.recipients.join(', ')}` : `not sent (${result.reason})`}`,
  });
  return {
    shopOpen: false,
    report:
      result.status === 'sent'
        ? { sent: true, message: `Today's report was emailed to ${result.recipients.join(', ')}.` }
        : { sent: false, message: REPORT_MESSAGE[result.reason] ?? `The report email could not be sent: ${result.reason.replace(/^send failed: /, '')}` },
  };
}
