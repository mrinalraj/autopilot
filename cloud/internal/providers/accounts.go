package providers

import (
	"context"
	"fmt"
	"github.com/mrinalraj/autopilot/cloud/internal/domain"
)

func (c *Client) Identity(ctx context.Context, i domain.Integration) (string, error) {
	switch i.Provider {
	case "linear":
		var v struct {
			Viewer struct {
				Name  string `json:"name"`
				Email string `json:"email"`
			} `json:"viewer"`
		}
		if e := c.graphql(ctx, i, `{viewer{name email}}`, nil, &v); e != nil {
			return "", e
		}
		return v.Viewer.Name + " · " + v.Viewer.Email, nil
	case "jira":
		var v struct {
			DisplayName string `json:"displayName"`
		}
		e := c.do(ctx, i, "GET", "/rest/api/3/myself", nil, &v)
		return v.DisplayName, e
	case "github":
		var v struct {
			Login string `json:"login"`
		}
		e := c.do(ctx, i, "GET", "/user", nil, &v)
		return v.Login, e
	case "gitlab":
		var v struct {
			Username string `json:"username"`
		}
		e := c.do(ctx, i, "GET", "/user", nil, &v)
		return v.Username, e
	}
	return "", fmt.Errorf("unsupported account provider")
}
