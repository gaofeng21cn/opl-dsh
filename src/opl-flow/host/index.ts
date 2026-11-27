import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  OplFlowActionResult,
  OplFlowApproveRequest,
  OplFlowAvailability,
  OplFlowDashboardEnvelope,
  OplFlowSendRequest,
  OplFlowServiceRequest,
  OplFlowTickRequest,
} from '../contracts/index.ts'
import {
  probeOplFlowControlPlane,
  runOplFlowContribution,
  type ProbeOplFlowOptions,
} from './probe.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oplFlow: OplFlowService
  }
}

export class OplFlowService extends TypertRemoteService {
  static inject = ['typertGateway']

  constructor(
    ctx: Context,
    private readonly probeOptions: ProbeOplFlowOptions = {},
  ) {
    super(ctx, 'oplFlow')
  }

  @Remote('availability')
  availability(): Promise<OplFlowAvailability> {
    return probeOplFlowControlPlane(this.probeOptions)
  }

  @Remote('dashboard')
  async dashboard(): Promise<OplFlowDashboardEnvelope> {
    const avail = await probeOplFlowControlPlane(this.probeOptions)
    if (!avail.available) {
      return {
        ok: false,
        state: 'unavailable',
        reason: avail.reason ?? 'OPL Flow control plane is unavailable',
      }
    }
    const envelope = await runOplFlowContribution<OplFlowDashboardEnvelope>(
      'dashboard',
      {
        include_local_navigation: true,
        host_carrier: 'dsh',
      },
      this.probeOptions,
    )
    if (!envelope || typeof envelope !== 'object') {
      return { ok: false, state: 'error', reason: 'Invalid OPL Flow dashboard response' }
    }
    return envelope
  }

  @Remote('send')
  send(request: OplFlowSendRequest): Promise<OplFlowActionResult> {
    return runOplFlowContribution<OplFlowActionResult>('send', request, this.probeOptions)
  }

  @Remote('approve')
  approve(request: OplFlowApproveRequest): Promise<OplFlowActionResult> {
    if (request.confirmed !== true) {
      return Promise.resolve({
        ok: false,
        message: 'Archive approval requires explicit confirmation',
      })
    }
    return runOplFlowContribution<OplFlowActionResult>(
      'approve',
      { ...request, approved_by: request.approved_by ?? 'owner', confirmed: true },
      this.probeOptions,
    )
  }

  @Remote('tick')
  tick(request: OplFlowTickRequest): Promise<OplFlowActionResult> {
    return runOplFlowContribution<OplFlowActionResult>('tick', request ?? {}, this.probeOptions)
  }

  @Remote('service')
  service(request: OplFlowServiceRequest): Promise<OplFlowActionResult> {
    if (request.action !== 'status' && request.confirmed !== true) {
      return Promise.resolve({
        ok: false,
        message: 'Router service change requires explicit confirmation',
      })
    }
    return runOplFlowContribution<OplFlowActionResult>('service', request, this.probeOptions)
  }
}
