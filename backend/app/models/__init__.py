"""Import all models so Alembic autogenerate and SQLAlchemy mapper see them."""
from app.models.tenancy import Tenant, Organization, TenantDomain  # noqa: F401
from app.models.iam import (  # noqa: F401
    Staff, Role, Permission, SkillGroup,
    staff_role, role_permission, staff_skillgroup,
)
from app.models.visitor import Contact, Visitor  # noqa: F401
from app.models.tag import Tag, TagRelation  # noqa: F401
from app.models.conversation import Channel, Session, Message  # noqa: F401
from app.models.knowledge import KnowledgeCollection, Document, QAPair  # noqa: F401
from app.models.ai import AIAgentConfig  # noqa: F401
from app.models.routing import RoutingPolicy  # noqa: F401
from app.models.ticket import Ticket  # noqa: F401
from app.models.quality import ServiceSummary, CSAT, QualityRecord  # noqa: F401
from app.models.billing import UsageRecord, Plan, Subscription, Invoice, Coupon  # noqa: F401
from app.models.canned import CannedResponse  # noqa: F401
from app.models.settings import TenantSettings  # noqa: F401
from app.models.automation import AutomationRule  # noqa: F401
from app.models.sla import SLAPolicy, SLATracking  # noqa: F401
from app.models.proactive import ProactiveRule  # noqa: F401
from app.models.webhook import WebhookEndpoint, ApiKey  # noqa: F401
from app.models.productivity import Macro, FieldDefinition  # noqa: F401
from app.models.ai_workflow import AIWorkflow  # noqa: F401
from app.models.collab import SideConversation, SideMessage, SessionParticipant  # noqa: F401
from app.models.analytics import PageView  # noqa: F401
from app.models.audit import AuditLog  # noqa: F401
from app.models.scheduling import StaffShift  # noqa: F401
from app.models.goals import Goal, GoalConversion  # noqa: F401
from app.models.company import Company  # noqa: F401
from app.models.ticket_note import TicketNote  # noqa: F401
from app.models.integration import TenantIntegration  # noqa: F401
from app.models.kb_analytics import KBHit  # noqa: F401
from app.models.sso import TenantSSOConfig  # noqa: F401
from app.models.report_schedule import ReportSchedule  # noqa: F401
