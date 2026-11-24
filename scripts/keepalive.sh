#!/bin/bash
# Render 무료 인스턴스가 잠들지 않게 9~19시 사이 10분마다 깨운다 (crontab에서 호출)
curl -s -o /dev/null -w "%{http_code}" --max-time 90 https://vat-workbench.onrender.com/api/health | sed "s/^/$(date '+%F %T') /" >> /tmp/vat-keepalive.log
echo >> /tmp/vat-keepalive.log
