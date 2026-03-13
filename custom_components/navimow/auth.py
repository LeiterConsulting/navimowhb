"""OAuth2 implementation for Navimow integration."""
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from homeassistant.core import HomeAssistant
from homeassistant.helpers.config_entry_oauth2_flow import LocalOAuth2Implementation

from .const import OAUTH2_AUTHORIZE, OAUTH2_TOKEN


class NavimowOAuth2Implementation(LocalOAuth2Implementation):
    """OAuth2 implementation for Navimow."""

    def __init__(
        self,
        hass: HomeAssistant,
        domain: str,
        client_id: str,
        client_secret: str,
    ) -> None:
        """Initialize Navimow OAuth2 implementation."""
        super().__init__(
            hass=hass,
            domain=domain,
            client_id=client_id,
            client_secret=client_secret,
            authorize_url=OAUTH2_AUTHORIZE,
            token_url=OAUTH2_TOKEN,
        )

    @property
    def name(self) -> str:
        """Return the name of the implementation."""
        return "Navimow"

    async def async_generate_authorize_url(self, *args, **kwargs) -> str:
        """Append channel=homeassistant without changing OAuth2 behavior."""
        url = await super().async_generate_authorize_url(*args, **kwargs)
        parsed = urlparse(url)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query.setdefault("channel", "homeassistant")
        return urlunparse(parsed._replace(query=urlencode(query)))
