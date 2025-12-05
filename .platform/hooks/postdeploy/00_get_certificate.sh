#!/usr/bin/env bash
# .platform/hooks/postdeploy/00_get_certificate.sh
sudo certbot -n -d ella-levantando.is404.net --nginx --agree-tos --email isaac.pratte@gmail.com